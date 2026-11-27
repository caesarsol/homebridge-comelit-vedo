import {
  AlarmArea,
  AreaDesc,
  VedoClient,
  VedoClientConfig,
  ZoneDesc,
  ZoneStatus,
} from 'comelit-client';
import { intersection } from 'lodash';
import {
  CharacteristicSetCallback,
  CharacteristicEventTypes,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';
import { ComelitVedoPlatform } from '../comelit-vedo-platform';
import { difference } from 'lodash';

const ALL = 32;

export interface ExtendedAreas {
  areas?: string[];
  shortcut?: string;
}

export interface VedoAlarmConfig extends Partial<VedoClientConfig> {
  away_areas?: ExtendedAreas;
  night_areas?: ExtendedAreas;
  home_areas?: ExtendedAreas;
}

// The VEDO drops a session about 2 minutes after its login, whatever the traffic.
const SESSION_REFRESH_MS = 60000;
// A replaced session stays open this long, for the reads still in flight on it.
const OLD_SESSION_GRACE_MS = 10000;

export class VedoAlarm {
  readonly client: VedoClient;
  readonly log: Logger;
  readonly accessory: PlatformAccessory;
  readonly platform: ComelitVedoPlatform;
  readonly name: string;
  private readonly code: string;
  private securityService: Service;
  private lastUID: string;
  private lastLogin: number;
  private renewing: Promise<void>;
  private readonly away_areas: ExtendedAreas;
  private readonly night_areas: ExtendedAreas;
  private readonly home_areas: ExtendedAreas;
  private readonly alwaysOnAreas: string[];
  private zones: ZoneDesc;
  private areas: AreaDesc;
  private triggerCount: number;

  constructor(
    platform: ComelitVedoPlatform,
    accessory: PlatformAccessory,
    address: string,
    port: number,
    code: string,
    config: VedoAlarmConfig
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.code = code;
    this.name = 'VEDO Alarm @ ' + address;
    this.client = new VedoClient(address, port, config);
    this.client.setLogger(platform.log);
    this.triggerCount = 0;
    this.away_areas = {
      areas:
        config.away_areas && config.away_areas.areas
          ? config.away_areas.areas.map(a => a.toLowerCase().trim())
          : [],
      shortcut: config.away_areas ? config.away_areas.shortcut : null,
    };
    this.night_areas = {
      areas:
        config.night_areas && config.night_areas.areas
          ? config.night_areas.areas.map(a => a.toLowerCase().trim())
          : [],
      shortcut: config.night_areas ? config.night_areas.shortcut : null,
    };
    this.home_areas = {
      areas:
        config.home_areas && config.home_areas.areas
          ? config.home_areas.areas.map(a => a.toLowerCase().trim())
          : [],
      shortcut: config.home_areas ? config.home_areas.shortcut : null,
    };
    this.alwaysOnAreas = platform.config.always_on_areas
      ? platform.config.always_on_areas.map(a => a.toLowerCase().trim())
      : [];
    this.lastLogin = 0;
    this.log.debug('Mapping areas set to ', this.night_areas, this.away_areas, this.home_areas);
    this.getAvailableServices();
  }

  getShortcutNumberFromString = (shortcut: string): number => {
    if (shortcut === 'tot') return 4;
    return parseInt(shortcut.substring(1));
  };

  update(alarmAreas: AlarmArea[]) {
    const Characteristic = this.platform.homebridge.hap.Characteristic;
    const currentAlarmStatus = this.securityService.getCharacteristic(
      Characteristic.SecuritySystemCurrentState
    ).value;
    // remove always-on areas from the check
    const armedAreas = difference(
      alarmAreas.filter((area: AlarmArea) => area.armed).map(a => a.description.toLowerCase()),
      this.alwaysOnAreas
    ); // alwaysOnAreas should be an empty array if not set
    const shortcutArmed = alarmAreas.filter((area: AlarmArea) => area.armed).map(a => a.shortcut);
    const statusArmed = armedAreas.length !== 0;
    if (statusArmed) {
      this.log.debug(`Found ${armedAreas.length} armed areas: ${armedAreas.join(', ')}`);
    } else {
      this.log.debug('No armed areas');
    }
    const triggered = alarmAreas.reduce(
      (triggered: boolean, area: AlarmArea) => triggered || area.triggered || area.sabotaged,
      false
    );
    if (statusArmed && triggered) {
      const s = alarmAreas
        .filter(a => a.triggered || a.sabotaged)
        .map(a => a.description)
        .join(', ');
      this.log.warn(`Alarm triggered in area ${s}`);
      this.triggerCount++;
    } else {
      this.triggerCount = 0;
      this.log.debug('No triggering areas');
    }
    if (
      triggered &&
      currentAlarmStatus !== Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED &&
      this.triggerCount >= 3
    ) {
      this.securityService.updateCharacteristic(
        Characteristic.SecuritySystemCurrentState,
        Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
      );
      return;
    }

    if (statusArmed) {
      if (
        this.away_areas.shortcut &&
        this.away_areas.areas.length &&
        intersection(armedAreas, this.away_areas.areas).length === armedAreas.length &&
        shortcutArmed.includes(this.getShortcutNumberFromString(this.away_areas.shortcut))
      ) {
        this.log.debug('Setting new status to AWAY_ARM');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.AWAY_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.AWAY_ARM
        );
      } else if (
        this.home_areas.shortcut &&
        this.home_areas.areas.length &&
        intersection(armedAreas, this.home_areas.areas).length === armedAreas.length &&
        shortcutArmed.includes(this.getShortcutNumberFromString(this.home_areas.shortcut))
      ) {
        this.log.debug('Setting new status to STAY_ARM');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.STAY_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.STAY_ARM
        );
      } else if (
        this.night_areas.shortcut &&
        this.night_areas.areas.length &&
        intersection(armedAreas, this.night_areas.areas).length === armedAreas.length &&
        shortcutArmed.includes(this.getShortcutNumberFromString(this.night_areas.shortcut))
      ) {
        this.log.debug('Setting new status to NIGHT_ARM');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.NIGHT_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.NIGHT_ARM
        );
      } else if (
        this.away_areas.areas.length &&
        intersection(armedAreas, this.away_areas.areas).length === armedAreas.length
      ) {
        this.log.debug('Setting new status to AWAY_ARM');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.AWAY_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.AWAY_ARM
        );
      } else if (
        this.home_areas.areas.length &&
        intersection(armedAreas, this.home_areas.areas).length === armedAreas.length
      ) {
        this.log.debug('Setting new status to STAY_ARM');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.STAY_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.STAY_ARM
        );
      } else if (
        this.night_areas.areas.length &&
        intersection(armedAreas, this.night_areas.areas).length === armedAreas.length
      ) {
        this.log.debug('Setting new status to NIGHT_ARM');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.NIGHT_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.NIGHT_ARM
        );
      } else {
        this.log.debug('Setting new status to AWAY_ARM (default)');
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemCurrentState,
          Characteristic.SecuritySystemCurrentState.AWAY_ARM
        );
        this.securityService.updateCharacteristic(
          Characteristic.SecuritySystemTargetState,
          Characteristic.SecuritySystemTargetState.AWAY_ARM
        );
      }
    } else {
      this.log.debug('Setting new status to DISARMED');
      this.securityService.updateCharacteristic(
        Characteristic.SecuritySystemCurrentState,
        Characteristic.SecuritySystemCurrentState.DISARMED
      );
      this.securityService.updateCharacteristic(
        Characteristic.SecuritySystemTargetState,
        Characteristic.SecuritySystemTargetState.DISARM
      );
    }
  }

  async fetchZones(): Promise<ZoneStatus[]> {
    try {
      await this.refreshUID();
      const uid = this.lastUID;
      if (!this.zones) {
        this.zones = await this.client.zoneDesc(uid);
      }

      const zones = await this.client.zoneStatus(uid, this.zones);
      await this.checkStillLogged(uid);
      return zones;
    } catch (e) {
      this.log.error(`Error fetching zones: ${e.message}`);
    }
    this.log.error('Unable to fetch token');
    this.lastUID = null;
    return null;
  }

  async checkAlarm(): Promise<AlarmArea[]> {
    try {
      await this.refreshUID();
      const uid = this.lastUID;
      if (!this.areas) {
        this.areas = await this.client.areaDesc(uid);
      }

      const areas = await this.client.findActiveAreas(uid, this.areas);
      await this.checkStillLogged(uid);
      return areas;
    } catch (e) {
      this.log.error(`Error checking alarm: ${e.message}`);
    }
    this.log.error('Unable to fetch token');
    this.lastUID = null;
    return null;
  }

  /*
   * A session that expires during a read answers "Not logged" in place of the data, which
   * comelit-client parses into every area armed and triggered. Sessions never come back to
   * life, so one still logged after the read proves the read good.
   */
  private async checkStillLogged(uid: string) {
    if (!(await this.client.isLogged(uid))) {
      throw new Error('session expired during the read');
    }
  }

  async includeZone(index: number) {
    try {
      await this.refreshUID();
      await this.client.includeZone(this.lastUID, index);
    } catch (e) {
      this.log.error(`Error including zone: ${e.message}`);
    }
    this.log.error('Unable to fetch token');
    this.lastUID = null;
    return null;
  }

  async excludeZone(index: number) {
    try {
      await this.refreshUID();
      await this.client.excludeZone(this.lastUID, index);
    } catch (e) {
      this.log.error(`Error excluding zone: ${e.message}`);
    }
    this.log.error('Unable to fetch token');
    this.lastUID = null;
    return null;
  }

  private getAvailableServices(): Service[] {
    const Characteristic = this.platform.homebridge.hap.Characteristic;
    const Service = this.platform.homebridge.hap.Service;
    const accessoryInformation =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    accessoryInformation
      .setCharacteristic(Characteristic.Name, 'Vedo Alarm')
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'None')
      .setCharacteristic(Characteristic.FirmwareRevision, 'None')
      .setCharacteristic(Characteristic.SerialNumber, 'None');

    this.securityService =
      this.accessory.getService(Service.SecuritySystem) ||
      this.accessory.addService(Service.SecuritySystem);
    this.securityService.setCharacteristic(Characteristic.Name, 'VEDO Alarm');

    const validValues = [
      Characteristic.SecuritySystemTargetState.DISARM,
      Characteristic.SecuritySystemTargetState.AWAY_ARM,
    ];

    if (this.night_areas.areas.length) {
      validValues.push(Characteristic.SecuritySystemTargetState.NIGHT_ARM);
    }

    if (this.home_areas.areas.length) {
      validValues.push(Characteristic.SecuritySystemTargetState.STAY_ARM);
    }

    this.securityService.updateCharacteristic(
      Characteristic.SecuritySystemTargetState,
      Characteristic.SecuritySystemTargetState.DISARM
    );
    this.securityService.updateCharacteristic(
      Characteristic.SecuritySystemCurrentState,
      Characteristic.SecuritySystemCurrentState.DISARMED
    );

    this.securityService
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({
        validValues,
      })
      .on(
        CharacteristicEventTypes.SET,
        async (value: number, callback: CharacteristicSetCallback) =>
          this.setTargetState(value, callback)
      );

    return [accessoryInformation, this.securityService];
  }

  private async armAreas(areas: string[], uid: string, shortcut?: string): Promise<number[]> {
    this.log.info(`Arming system: ${areas.length ? areas.join(', ') : 'ALL SYSTEM'}`);
    const alarmAreas = await this.client.findActiveAreas(uid);
    if (areas && areas.length) {
      const indexes = areas
        .map(area => alarmAreas.findIndex(a => a.description.toLowerCase() === area))
        .filter(index => index !== -1);
      if (indexes.length) {
        const promises = indexes.map(index => this.client.arm(uid, index, true, shortcut));
        await Promise.all(promises);
        return indexes;
      }
    }
    await this.client.arm(uid, ALL);
    return [ALL];
  }

  /*
   * A login takes 3-15 s (the session must reach rt_stat 9). Once the session is
   * SESSION_REFRESH_MS old, a new one is opened in the background and replaces it only when
   * ready, so reads wait for a login only at start and after an expiry. Concurrent callers
   * (zones and areas polling) share one login. An expired session answers 200 with
   * "Not logged" in place of the data, hence the isLogged() checks.
   */
  private async refreshUID() {
    if (this.lastUID && !(await this.client.isLogged(this.lastUID))) {
      this.lastUID = null;
    }
    if (!this.lastUID) {
      await this.renewUID();
    } else if (Date.now() - this.lastLogin > SESSION_REFRESH_MS) {
      this.renewUID().catch(e => this.log.debug(`Session renewal failed: ${e.message}`));
    }
  }

  private renewUID(): Promise<void> {
    if (!this.renewing) {
      this.renewing = this.client.loginWithRetry(this.code).then(
        uid => {
          this.renewing = null;
          const old = this.lastUID;
          this.lastUID = uid;
          this.lastLogin = Date.now();
          if (old) {
            setTimeout(() => this.client.logout(old).catch(() => null), OLD_SESSION_GRACE_MS);
          }
        },
        e => {
          this.renewing = null;
          throw e;
        }
      );
    }
    return this.renewing;
  }

  private async setTargetState(value: number, callback: CharacteristicSetCallback) {
    const Characteristic = this.platform.homebridge.hap.Characteristic;
    try {
      const uid = await this.client.loginWithRetry(this.code);
      if (uid) {
        switch (value) {
          case Characteristic.SecuritySystemTargetState.DISARM:
            this.log.info('Disarming system');
            await this.client.disarm(uid, ALL);
            callback();
            break;
          case Characteristic.SecuritySystemTargetState.AWAY_ARM:
            this.log.info('Arm system: AWAY');
            await this.armAreas(this.away_areas.areas, uid, this.away_areas.shortcut);
            callback();
            break;
          case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
            this.log.info('Arm system: NIGHT');
            await this.armAreas(this.night_areas.areas, uid, this.night_areas.shortcut);
            callback();
            break;
          case Characteristic.SecuritySystemTargetState.STAY_ARM:
            this.log.info('Arm system: STAY');
            await this.armAreas(this.home_areas.areas, uid, this.home_areas.shortcut);
            callback();
            break;
          default:
            callback(new Error(`Cannot execute requested action ${value}`));
        }
      } else {
        callback(new Error('Cannot login into system'));
      }
    } catch (e) {
      callback(e);
    }
  }
}
