// Generated from src/guidance/core.ts; SHA256 d79ac148a54769f84242a25b7dd8760fd2652b12f03678d80428b57b4f3457a4. Do not edit.
/** Canonical sailing guidance. Browser copies are generated, never hand-tuned. */
export const GUIDANCE_VERSION = 1;
export const GUIDANCE_ALGORITHM = 'sailing-guidance-v1';
export const normalizeDegrees = (x) => ((x % 360) + 360) % 360;
export const signedDegrees = (x) => normalizeDegrees(x + 180) - 180;
const rad = (x) => x * Math.PI / 180;
const deg = (x) => x * 180 / Math.PI;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const vector = (speed, bearing) => [speed * Math.sin(rad(bearing)), speed * Math.cos(rad(bearing))];
const direction = (east, north) => normalizeDegrees(deg(Math.atan2(east, north)));
const fresh = (x, at, age) => !!x && finite(x.at) && at >= x.at - 1000 && at - x.at <= age;
const scalar = (x, at, age, low, high) => fresh(x, at, age) && finite(x?.value) && x.value >= low && x.value <= high;
const windFresh = (x, at, age) => fresh(x, at, age) && (x?.validUntil === undefined || at <= x.validUntil) && finite(x?.east) && finite(x?.north) && Math.hypot(x.east, x.north) <= 200;
const round = (x) => Math.round(x * 1e6) / 1e6;
class VectorFilter {
    east = 0;
    north = 0;
    at = -Infinity;
    source = '';
    reset() { this.at = -Infinity; }
    update(east, north, at, source, tau) {
        if (source !== this.source || at - this.at > 10000) {
            this.east = east;
            this.north = north;
            this.source = source;
            this.at = at;
        }
        else if (at > this.at) {
            const alpha = tau <= 0 ? 1 : 1 - Math.exp(-(at - this.at) / (tau * 1000));
            this.east += alpha * (east - this.east);
            this.north += alpha * (north - this.north);
            this.at = at;
        }
        return [this.east, this.north];
    }
}
export class GuidanceEngine {
    config;
    headingFilter = new VectorFilter();
    windFilter = new VectorFilter();
    currentFilter = new VectorFilter();
    leewayFilter = new VectorFilter();
    oppositeLeewayFilter = new VectorFilter();
    lastHeading = null;
    turnStart = null;
    turnDirection = 0;
    turnUntil = -Infinity;
    session;
    lastAt = -Infinity;
    mode = null;
    side = null;
    result = null;
    constructor(config = {}) {
        this.config = config;
    }
    reset() {
        this.headingFilter.reset();
        this.windFilter.reset();
        this.currentFilter.reset();
        this.leewayFilter.reset();
        this.oppositeLeewayFilter.reset();
        this.lastHeading = null;
        this.lastAt = -Infinity;
        this.turnStart = null;
        this.turnUntil = -Infinity;
        this.mode = null;
        this.side = null;
        this.result = null;
    }
    update(input) {
        const at = input.at, age = this.config.maxAgeMs ?? 30000;
        if (!finite(at))
            return null;
        if (at < this.lastAt)
            return this.result ? structuredClone(this.result) : null;
        if (this.session !== input.session || this.lastHeading && input.heading && input.heading.at - this.lastHeading.at > 10000)
            this.reset();
        this.session = input.session;
        this.lastAt = at;
        const h = input.heading;
        if (!scalar(h, at, age, -3600, 3600)) {
            this.result = null;
            this.headingFilter.reset();
            return null;
        }
        const previous = this.lastHeading;
        if (previous && h.at > previous.at) {
            const elapsed = (h.at - previous.at) / 1000;
            const change = signedDegrees(h.value - previous.value);
            const rate = scalar(input.rateOfTurn, at, age, -180, 180) ? input.rateOfTurn.value : change / elapsed;
            const rudderEvidence = scalar(input.rudder, at, age, -45, 45) && Math.abs(input.rudder.value) > 3;
            const turnThreshold = rudderEvidence ? 1.5 : 3;
            if (Math.abs(change) >= 30 && elapsed <= 3) {
                // A confirmed large course change must not average opposite tacks.
                this.headingFilter.reset();
                this.turnUntil = h.at + 1500;
            }
            else if (Math.abs(rate) > turnThreshold) {
                if (Math.sign(rate) !== this.turnDirection)
                    this.turnStart = h.at;
                this.turnDirection = Math.sign(rate);
                this.turnStart ??= h.at;
                if (h.at - this.turnStart >= 700)
                    this.turnUntil = h.at + 1500;
            }
            else
                this.turnStart = null;
        }
        if (!previous || h.at >= previous.at)
            this.lastHeading = { ...h };
        const turning = at < this.turnUntil;
        const hv = vector(1, h.value);
        const [he, hn] = this.headingFilter.update(hv[0], hv[1], h.at, h.source ?? '', turning ? 0.35 : this.config.headingTauSeconds ?? 2);
        if (Math.hypot(he, hn) < 0.05) {
            this.result = null;
            return null;
        }
        const heading = direction(he, hn), inputs = { heading: { ...h } };
        for (const name of ['sog', 'cog', 'stw', 'heel', 'pitch', 'yaw', 'rudder', 'leeway', 'rateOfTurn']) {
            const value = input[name];
            const bounds = { sog: [0, 80], cog: [-3600, 3600], stw: [0, 80], heel: [-90, 90], pitch: [-90, 90], yaw: [-3600, 3600], rudder: [-45, 45], leeway: [-25, 25], rateOfTurn: [-180, 180] };
            const [low, high] = bounds[name];
            if (scalar(value, at, age, low, high))
                inputs[name] = { ...value };
        }
        const s = {
            v: 1, algorithm: GUIDANCE_ALGORITHM, at, headingAt: h.at, headingDeg: round(heading), headingValidUntil: h.at + age,
            windAt: null, windFromDeg: null, windSpeedKn: null, windValidUntil: null,
            kind: null, currentTack: null, turning, motionUnstable: scalar(input.heel, at, age, -90, 90) && Math.abs(input.heel.value) > 45 || scalar(input.pitch, at, age, -90, 90) && Math.abs(input.pitch.value) > 30, waterWindFromDeg: null, waterSpeedKn: null, targetTwaDeg: null, targetSpeedKn: null,
            currentEastKn: null, currentNorthKn: null, currentAt: null, currentBasis: 'unavailable', currentValidUntil: null,
            leewayDeg: null, oppositeLeewayDeg: null, leewayAt: null, leewayBasis: 'unavailable', correctionValidUntil: null, inputs
        };
        const stw = input.stw, heel = input.heel, rudder = input.rudder, measuredLeeway = input.leeway;
        const speedValid = scalar(stw, at, age, 0.5, 80);
        if (speedValid)
            s.waterSpeedKn = stw.value;
        const calibration = this.config.calibration;
        if (scalar(measuredLeeway, at, age, -25, 25)) {
            s.leewayDeg = measuredLeeway.value;
            s.oppositeLeewayDeg = -measuredLeeway.value;
            s.leewayAt = measuredLeeway.at;
            s.leewayBasis = 'measured';
        }
        else if (calibration?.validated === true && calibration.id && speedValid && scalar(heel, at, age, -60, 60)
            && finite(calibration.heelCoefficient) && Math.abs(calibration.heelCoefficient) <= 100
            && stw.value >= Math.max(0.5, calibration.minSpeedKn ?? 2) && !turning) {
            const coefficient = heel.value >= 0 ? calibration.starboardHeelCoefficient ?? calibration.heelCoefficient : calibration.portHeelCoefficient ?? calibration.heelCoefficient;
            const oppositeCoefficient = heel.value >= 0 ? calibration.portHeelCoefficient ?? calibration.heelCoefficient : calibration.starboardHeelCoefficient ?? calibration.heelCoefficient;
            const base = coefficient * heel.value / stw.value ** 2;
            const useRudder = scalar(rudder, at, age, -45, 45) && finite(calibration.rudderCoefficient) && Math.abs(calibration.rudderCoefficient) <= 2;
            const estimate = base + (useRudder ? calibration.rudderCoefficient * rudder.value : 0);
            const limit = Math.min(25, Math.max(0, calibration.maxLeewayDeg ?? 15));
            if (finite(estimate) && Math.abs(estimate) <= limit && finite(oppositeCoefficient)) {
                s.leewayDeg = estimate;
                s.oppositeLeewayDeg = -oppositeCoefficient * heel.value / stw.value ** 2;
                if (Math.abs(s.oppositeLeewayDeg) > limit)
                    s.oppositeLeewayDeg = null;
                s.leewayAt = Math.min(stw.at, heel.at, useRudder ? rudder.at : Infinity);
                s.leewayBasis = useRudder ? 'calibrated-rudder' : 'calibrated-heel';
            }
        }
        if (s.leewayDeg !== null && s.leewayAt !== null) {
            const [east, north] = this.leewayFilter.update(...vector(1, s.leewayDeg), s.leewayAt, s.leewayBasis === 'measured' ? 'measured' : calibration?.id ?? '', 2);
            s.leewayDeg = signedDegrees(direction(east, north));
            if (s.oppositeLeewayDeg !== null) {
                const [oe, on] = this.oppositeLeewayFilter.update(...vector(1, s.oppositeLeewayDeg), s.leewayAt, s.leewayBasis === 'measured' ? 'measured' : calibration?.id ?? '', 2);
                s.oppositeLeewayDeg = signedDegrees(direction(oe, on));
            }
        }
        else {
            this.leewayFilter.reset();
            this.oppositeLeewayFilter.reset();
        }
        if (speedValid)
            s.waterSpeedKn = stw.value / Math.cos(rad(s.leewayDeg ?? 0));
        let current = null;
        if (windFresh(input.current, at, age) && Math.hypot(input.current.east, input.current.north) <= 15) {
            current = input.current;
            s.currentBasis = 'provided';
        }
        else if (speedValid && s.leewayDeg !== null && scalar(input.sog, at, age, 0, 80) && scalar(input.cog, at, age, -3600, 3600)
            && Math.max(h.at, stw.at, input.sog.at, input.cog.at) - Math.min(h.at, stw.at, input.sog.at, input.cog.at) <= 2000 && !turning) {
            const water = vector(s.waterSpeedKn, h.value + s.leewayDeg), ground = vector(input.sog.value, input.cog.value);
            current = { east: ground[0] - water[0], north: ground[1] - water[1], at: Math.min(h.at, stw.at, input.sog.at, input.cog.at, s.leewayAt), source: 'water-ground-residual:' + s.leewayBasis };
            if (Math.hypot(current.east, current.north) <= 15)
                s.currentBasis = 'derived';
            else
                current = null;
        }
        if (current) {
            const [east, north] = this.currentFilter.update(current.east, current.north, current.at, current.source ?? s.currentBasis, 8);
            s.currentEastKn = round(east);
            s.currentNorthKn = round(north);
            s.currentAt = current.at;
            s.currentValidUntil = current.at + age;
            s.inputs.currentEast = { value: current.east, at: current.at, source: current.source };
            s.inputs.currentNorth = { value: current.north, at: current.at, source: current.source };
        }
        if (speedValid)
            s.correctionValidUntil = Math.min(stw.at + age, s.leewayAt === null ? Infinity : s.leewayAt + age, s.currentValidUntil ?? Infinity);
        if (windFresh(input.wind, at, age)) {
            const [east, north] = this.windFilter.update(input.wind.east, input.wind.north, input.wind.at, input.wind.source ?? '', this.config.windTauSeconds ?? 5);
            const speed = Math.hypot(east, north);
            if (speed > 0.1) {
                s.windAt = input.wind.at;
                s.windValidUntil = input.wind.validUntil ?? input.wind.at + age;
                s.windFromDeg = round(direction(east, north));
                s.windSpeedKn = round(speed);
                s.inputs.windEast = { value: input.wind.east, at: input.wind.at, source: input.wind.source };
                s.inputs.windNorth = { value: input.wind.north, at: input.wind.at, source: input.wind.source };
                // Meteorological FROM vectors: water wind = ground wind + current TO.
                const waterEast = east + (current ? s.currentEastKn : 0), waterNorth = north + (current ? s.currentNorthKn : 0);
                if (Math.hypot(waterEast, waterNorth) > 0.1)
                    s.waterWindFromDeg = round(direction(waterEast, waterNorth));
                const twa = signedDegrees((current && (speedValid || this.config.polar?.validated) ? s.waterWindFromDeg ?? s.windFromDeg : s.windFromDeg) - heading), angle = Math.abs(twa);
                if (angle >= 20 && angle < 87 || this.mode === 'tack' && angle >= 17 && angle < 93)
                    this.mode = 'tack';
                else if (angle > 103 && angle < 175 || this.mode === 'gybe' && angle > 97 && angle < 178)
                    this.mode = 'gybe';
                else
                    this.mode = null;
                if (Math.abs(twa) >= 3 && Math.abs(twa) <= 177)
                    this.side = twa > 0 ? 'starboard' : 'port';
                if (!turning && !s.motionUnstable) {
                    s.kind = this.mode;
                    s.currentTack = this.mode ? this.side : null;
                }
                const polar = this.config.polar;
                if (s.kind && polar?.validated === true && polar.points.length) {
                    const waterWindSpeed = Math.hypot(waterEast, waterNorth);
                    const upper = polar.points.findIndex(p => p.twsKn >= waterWindSpeed);
                    const a = polar.points[Math.max(0, upper < 0 ? polar.points.length - 1 : upper - 1)];
                    const b = polar.points[upper < 0 ? polar.points.length - 1 : upper];
                    const ratio = b.twsKn === a.twsKn ? 0 : Math.max(0, Math.min(1, (waterWindSpeed - a.twsKn) / (b.twsKn - a.twsKn)));
                    const angleKey = s.kind === 'tack' ? 'upwindTwaDeg' : 'downwindTwaDeg';
                    const speedKey = s.kind === 'tack' ? 'upwindSpeedKn' : 'downwindSpeedKn';
                    const angle = a[angleKey] + ratio * (b[angleKey] - a[angleKey]), targetSpeed = a[speedKey] + ratio * (b[speedKey] - a[speedKey]);
                    if (finite(angle) && angle >= 20 && angle <= 175 && finite(targetSpeed) && targetSpeed >= 0.5 && targetSpeed <= 80) {
                        s.targetTwaDeg = angle;
                        s.targetSpeedKn = targetSpeed;
                    }
                }
            }
        }
        else
            this.windFilter.reset();
        this.result = s;
        return structuredClone(s);
    }
}
/** Check freshness again at the consumer: polling must not refresh source age. */
export function guidanceBearings(s, now, options = {}) {
    const out = { headingDeg: null, currentCourseDeg: null, oppositeCourseDeg: null, oppositeHeadingDeg: null, trueWindFromDeg: null, trueWindSpeedKn: null, kind: null, currentTack: null, courseToSteerDeg: null, corrected: false, turning: false };
    if (!s || s.v !== 1 || s.algorithm !== GUIDANCE_ALGORITHM || !finite(s.headingDeg) || !finite(s.headingAt) || !finite(s.headingValidUntil)
        || now < s.headingAt - 1000 || now > s.headingValidUntil)
        return out;
    out.headingDeg = s.headingDeg;
    out.turning = s.turning;
    if (!finite(s.windFromDeg) || !finite(s.windSpeedKn) || s.windSpeedKn <= 0.1 || s.windAt === null || s.windValidUntil === null || now < s.windAt - 1000 || now > s.windValidUntil || !s.kind || !s.currentTack || s.turning)
        return out;
    const currentValid = s.currentValidUntil !== null && now <= s.currentValidUntil && finite(s.currentEastKn) && finite(s.currentNorthKn);
    const correctionValid = s.correctionValidUntil !== null && now <= s.correctionValidUntil && finite(s.waterSpeedKn) && s.waterSpeedKn >= 0.5;
    const usePolar = finite(s.targetTwaDeg) && finite(s.targetSpeedKn) && s.targetSpeedKn >= 0.5;
    const windFrom = currentValid && (correctionValid || usePolar) && finite(s.waterWindFromDeg) ? s.waterWindFromDeg : s.windFromDeg;
    const leg = options.legBearingDeg;
    if (finite(leg)) {
        const angle = Math.abs(signedDegrees(leg - windFrom));
        if (s.kind === 'tack' ? angle >= 90 : angle <= 90)
            return out;
    }
    const side = s.currentTack === 'starboard' ? 1 : -1;
    const activeHeading = usePolar ? normalizeDegrees(windFrom - side * s.targetTwaDeg) : s.headingDeg;
    const opposite = usePolar ? normalizeDegrees(windFrom + side * s.targetTwaDeg) : normalizeDegrees(2 * windFrom - s.headingDeg);
    const groundCourse = (heading, leeway) => {
        if (!correctionValid && !usePolar)
            return heading;
        const waterSpeed = usePolar ? s.targetSpeedKn : s.waterSpeedKn * Math.cos(rad(s.leewayDeg ?? 0)) / Math.cos(rad(leeway ?? 0));
        const water = vector(waterSpeed, heading + (leeway ?? 0));
        const east = water[0] + (currentValid ? s.currentEastKn : 0), north = water[1] + (currentValid ? s.currentNorthKn : 0);
        return Math.hypot(east, north) >= 0.2 ? direction(east, north) : null;
    };
    out.currentCourseDeg = groundCourse(activeHeading, s.leewayDeg);
    out.oppositeCourseDeg = groundCourse(opposite, s.oppositeLeewayDeg);
    out.oppositeHeadingDeg = opposite;
    out.trueWindFromDeg = windFrom;
    out.trueWindSpeedKn = currentValid && (correctionValid || usePolar) ? Math.hypot(s.windSpeedKn * Math.sin(rad(s.windFromDeg)) + s.currentEastKn, s.windSpeedKn * Math.cos(rad(s.windFromDeg)) + s.currentNorthKn) : s.windSpeedKn;
    out.currentTack = s.currentTack;
    out.kind = s.kind;
    out.corrected = (correctionValid || usePolar) && (currentValid || s.leewayDeg !== null);
    const target = options.targetBearingDeg;
    if (finite(target) && (correctionValid || usePolar) && currentValid) {
        const steeringSpeed = usePolar ? s.targetSpeedKn : s.waterSpeedKn;
        const unit = vector(1, target), right = vector(1, target + 90);
        const cross = s.currentEastKn * right[0] + s.currentNorthKn * right[1];
        if (Math.abs(cross) < steeringSpeed) {
            const waterBearing = target - deg(Math.asin(cross / steeringSpeed));
            const forward = steeringSpeed * Math.cos(rad(waterBearing - target)) + s.currentEastKn * unit[0] + s.currentNorthKn * unit[1];
            const candidate = normalizeDegrees(waterBearing - (s.leewayDeg ?? 0)), targetTwa = Math.abs(signedDegrees(windFrom - candidate));
            const onSameTack = Math.sign(signedDegrees(windFrom - candidate)) === (s.currentTack === 'starboard' ? 1 : -1);
            if (forward > 0.2 && targetTwa >= 30 && targetTwa <= 175 && onSameTack)
                out.courseToSteerDeg = round(candidate);
        }
    }
    return out;
}
