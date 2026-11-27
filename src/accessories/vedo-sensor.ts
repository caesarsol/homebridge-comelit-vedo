import { ZoneStatus } from 'comelit-client';
import {
  CharacteristicSetCallback,
  CharacteristicGetCallback,
  CharacteristicEventTypes,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';
import client from 'prom-client';
import { ComelitVedoPlatform } from '../comelit-vedo-platform';
import { VedoAlarm } from './vedo-alarm';

const triggers_count = new client.Counter({
  name: 'comelit_vedo_sensor_triggers',
  help: 'Number of triggered sensors',
});

export type SensorType = 'occupancy' | 'contact' | 'motion';

export class VedoSensor {
  readonly log: Logger;
  readonly platform: ComelitVedoPlatform;
  readonly accessory: PlatformAccessory;
  readonly name: string;
  readonly alarm: VedoAlarm;
  private readonly zoneStatus: ZoneStatus;
  private readonly type: SensorType;
  private readonly exclusionSwitch: boolean;
  private sensorService: Service;
  private switchService: Service;

  constructor(
    platform: ComelitVedoPlatform,
    accessory: PlatformAccessory,
    name: string,
    zoneStatus: ZoneStatus,
    alarm: VedoAlarm,
    type: SensorType = 'occupancy',
    exclusionSwitch = true
  ) {
    this.log = platform.log;
    this.accessory = accessory;
    this.platform = platform;
    this.name = name;
    this.zoneStatus = zoneStatus;
    this.alarm = alarm;
    this.type = type;
    this.exclusionSwitch = exclusionSwitch;
    this.getAvailableServices();
  }

  update(zoneStatus: ZoneStatus) {
    const sensor = this.sensorTypes()[this.type];
    const characteristic = this.sensorService.getCharacteristic(sensor.characteristic);
    const newValue = zoneStatus.open ? sensor.open : sensor.closed;
    if (characteristic.value !== newValue) {
      if (zoneStatus.open) {
        this.log.debug(`Sensor ${this.name} triggered`);
        triggers_count.inc();
      }
      characteristic.updateValue(newValue);
    }

    Object.assign(this.zoneStatus, zoneStatus);
  }

  private sensorTypes() {
    const { Service, Characteristic } = this.platform.homebridge.hap;
    return {
      occupancy: {
        service: Service.OccupancySensor,
        characteristic: Characteristic.OccupancyDetected,
        open: Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
        closed: Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      },
      contact: {
        service: Service.ContactSensor,
        characteristic: Characteristic.ContactSensorState,
        open: Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        closed: Characteristic.ContactSensorState.CONTACT_DETECTED,
      },
      motion: {
        service: Service.MotionSensor,
        characteristic: Characteristic.MotionDetected,
        open: true,
        closed: false,
      },
    };
  }

  private getAvailableServices(): Service[] {
    const Service = this.platform.homebridge.hap.Service;
    const Characteristic = this.platform.homebridge.hap.Characteristic;
    const accessoryInformation =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    accessoryInformation
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'None')
      .setCharacteristic(Characteristic.FirmwareRevision, 'None')
      .setCharacteristic(Characteristic.SerialNumber, 'None');

    // A cached accessory keeps the services of its previous configuration: drop them
    const sensorTypes = this.sensorTypes();
    Object.entries(sensorTypes)
      .filter(([type]) => type !== this.type)
      .map(([, other]) => this.accessory.getService(other.service))
      .filter(service => service)
      .forEach(service => this.accessory.removeService(service));

    const sensorService = sensorTypes[this.type].service;
    this.sensorService =
      this.accessory.getService(sensorService) || this.accessory.addService(sensorService);
    this.sensorService.setCharacteristic(Characteristic.Name, this.name);

    this.update(this.zoneStatus);

    const cachedSwitch = this.accessory.getService(Service.Switch);
    if (!this.exclusionSwitch) {
      if (cachedSwitch) {
        this.accessory.removeService(cachedSwitch);
      }
      return [accessoryInformation, this.sensorService];
    }

    this.switchService = cachedSwitch || this.accessory.addService(Service.Switch);

    this.switchService
      .getCharacteristic(Characteristic.On)
      .on(
        CharacteristicEventTypes.SET,
        async (value: boolean, callback: CharacteristicSetCallback) => {
          try {
            if (value) {
              await this.alarm.includeZone(this.zoneStatus.index);
            } else {
              await this.alarm.excludeZone(this.zoneStatus.index);
            }
            return callback();
          } catch (e) {
            callback(e);
          }
        }
      )
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        return callback(null, this.zoneStatus.excluded === false);
      });

    return [accessoryInformation, this.sensorService, this.switchService];
  }
}
