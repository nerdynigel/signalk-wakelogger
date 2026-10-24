// Generated from src/guidance/service.ts. Do not edit.
import { GuidanceEngine } from './sailing-guidance.mjs';
export const GUIDANCE_PATHS = [
    'navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.magneticVariation',
    'navigation.speedOverGround', 'navigation.courseOverGroundTrue', 'navigation.speedThroughWater',
    'navigation.rateOfTurn', 'navigation.attitude', 'navigation.leewayAngle', 'steering.rudderAngle',
    'environment.wind.speedApparent', 'environment.wind.angleApparent',
    'environment.wind.speedOverGround', 'environment.wind.directionTrue',
    'environment.current.setTrue', 'environment.current.drift'
];
const knots = 1.9438444924406, degrees = 180 / Math.PI;
export class GuidanceService {
    config;
    values = new Map();
    session;
    engine;
    constructor(config = {}) {
        this.config = config;
        this.engine = new GuidanceEngine(config);
    }
    get enabled() { return this.config.enabled !== false; }
    seedRest(navigation, environment, steering = {}, now = Date.now()) {
        const roots = { navigation, environment, steering };
        const updates = [];
        for (const path of GUIDANCE_PATHS) {
            let node = roots;
            for (const key of path.split('.'))
                node = node && typeof node === 'object' ? node[key] : undefined;
            if (!node || typeof node !== 'object' || !Number.isFinite(Date.parse(String(node.timestamp ?? '')))) {
                this.values.delete(path);
                if (path === 'navigation.attitude')
                    for (const key of ['heel', 'pitch', 'yaw'])
                        this.values.delete(key);
                continue;
            }
            const reading = node;
            updates.push({ timestamp: reading.timestamp, source: { label: String(reading.$source ?? 'rest') }, values: [{ path, value: reading.value }] });
        }
        this.ingest({ context: 'vessels.self', updates }, now);
    }
    reset() { this.values.clear(); this.engine.reset(); }
    ingest(delta, now = Date.now()) {
        for (const update of delta.updates) {
            if (!('values' in update))
                continue;
            const at = Date.parse(String(update.timestamp ?? ''));
            const sourceInfo = update.source;
            const source = `${sourceInfo?.label ?? sourceInfo?.type ?? ''}:${sourceInfo?.src ?? sourceInfo?.talker ?? ''}`;
            for (const item of update.values) {
                const name = String(item.path);
                if (!GUIDANCE_PATHS.includes(name))
                    continue;
                const old = this.values.get(name);
                if (item.state?.timedOut || item.value === null) {
                    this.values.delete(name);
                    if (name === 'navigation.attitude')
                        for (const key of ['heel', 'pitch', 'yaw'])
                            this.values.delete(key);
                    continue;
                }
                if (!Number.isFinite(at) || at > now + 1000 || now - at > 30000 || old && at < old.at)
                    continue;
                if (name === 'navigation.attitude') {
                    const attitude = item.value;
                    for (const [key, field] of [['heel', 'roll'], ['pitch', 'pitch'], ['yaw', 'yaw']]) {
                        const value = attitude?.[field];
                        if (typeof value === 'number' && Number.isFinite(value))
                            this.values.set(key, { value: value * degrees, at, source });
                        else
                            this.values.delete(key);
                    }
                }
                else if (typeof item.value === 'number' && Number.isFinite(item.value))
                    this.values.set(name, { value: item.value, at, source });
                else
                    this.values.delete(name);
            }
        }
        this.snapshot(now);
    }
    snapshot(now = Date.now(), session) {
        if (session !== undefined)
            this.session = session;
        if (this.config.enabled === false)
            return null;
        const get = (name, scale = 1) => {
            const value = this.values.get(name);
            return value && now - value.at <= 30000 && now >= value.at - 1000 ? { ...value, value: value.value * scale } : null;
        };
        let heading = get('navigation.headingTrue', degrees);
        if (!heading) {
            const magnetic = get('navigation.headingMagnetic', degrees), variation = get('navigation.magneticVariation', degrees);
            if (magnetic && variation && Math.abs(magnetic.at - variation.at) <= 10000)
                heading = { value: magnetic.value + variation.value, at: Math.min(magnetic.at, variation.at), source: 'magnetic-plus-variation:' + magnetic.source };
        }
        const sog = get('navigation.speedOverGround', knots), cog = get('navigation.courseOverGroundTrue', degrees);
        const coherent = (items) => items.every((r) => !!r) && Math.max(...items.map(r => r.at)) - Math.min(...items.map(r => r.at)) <= 2000;
        let wind = null, current = null;
        const groundSpeed = get('environment.wind.speedOverGround', knots), groundDirection = get('environment.wind.directionTrue');
        if (groundSpeed && groundDirection && coherent([groundSpeed, groundDirection]) && groundSpeed.value >= 0 && groundSpeed.value <= 200)
            wind = { east: groundSpeed.value * Math.sin(groundDirection.value), north: groundSpeed.value * Math.cos(groundDirection.value), at: Math.min(groundSpeed.at, groundDirection.at), source: 'ground:' + groundSpeed.source + ':' + groundDirection.source };
        else {
            const aws = get('environment.wind.speedApparent', knots), awa = get('environment.wind.angleApparent', degrees);
            if (aws && awa && heading && sog && cog && coherent([aws, awa, heading, sog, cog]) && aws.value > 0 && aws.value <= 120 && sog.value >= 0 && sog.value <= 80) {
                const from = (heading.value + awa.value) / degrees, motion = cog.value / degrees;
                wind = { east: aws.value * Math.sin(from) - sog.value * Math.sin(motion), north: aws.value * Math.cos(from) - sog.value * Math.cos(motion),
                    at: Math.min(aws.at, awa.at), validUntil: Math.min(aws.at, awa.at, heading.at, sog.at, cog.at) + 30000, source: 'apparent-ground:' + aws.source + ':' + heading.source + ':' + sog.source };
            }
        }
        const set = get('environment.current.setTrue'), drift = get('environment.current.drift', knots);
        if (set && drift && coherent([set, drift]) && drift.value >= 0 && drift.value <= 15)
            current = { east: drift.value * Math.sin(set.value), north: drift.value * Math.cos(set.value), at: Math.min(set.at, drift.at), source: set.source + ':' + drift.source };
        const input = { at: now, session: this.session, heading, wind, current, sog, cog, stw: get('navigation.speedThroughWater', knots),
            heel: get('heel'), pitch: get('pitch'), yaw: get('yaw'), rudder: get('steering.rudderAngle', degrees), leeway: get('navigation.leewayAngle', degrees), rateOfTurn: get('navigation.rateOfTurn', degrees) };
        return this.engine.update(input);
    }
}
