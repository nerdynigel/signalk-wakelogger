export type HeadingReference = 'true' | 'magnetic'
export type NetworkMode = 'NORMAL' | 'CONSTRAINED' | 'OFFLINE'
export type TelemetryField = 'position' | 'sog' | 'cog' | 'heading' | 'depth' | 'apparentWind'

export interface TelemetryQuality {
  timestamp: 'source' | 'receipt'
}

export interface TelemetryValues {
  lat: number
  lon: number
  sog_kn?: number
  cog_deg?: number
  heading_deg?: number
  heading_reference?: HeadingReference
  depth_m?: number
  aws_kn?: number
  awa_deg?: number
}

export interface TripEvidence {
  event: 'trip_start_candidate' | 'trip_started' | 'trip_stop_candidate' | 'trip_stopped'
  effectiveAt: number
  trackingSessionId?: string
  reason: {
    sogKn?: number
    distanceMovedMetres?: number
    movementDurationSeconds?: number
  }
}

export interface TelemetryDraft {
  capturedAt: number
  receivedAt: number
  trackingSessionId?: string
  values: TelemetryValues
  quality: TelemetryQuality
  cleared?: Exclude<TelemetryField, 'position'>[]
  evidence?: TripEvidence
}

export interface TelemetrySample extends TelemetryDraft {
  v: 1
  deviceId: string
  sequence: number
}

export interface TelemetryBatch {
  v: 1
  deviceId: string
  droppedThrough?: number
  samples: TelemetrySample[]
}

export interface ApplicationAck {
  v: 1
  deviceId: string
  ackSequence: number
  acknowledgedAt?: number
}

export interface PluginStatusMetrics {
  pluginVersion: string
  connectionState: string
  queueMessageCount: number
  queueDiskBytes: number
  queueOldestCapturedAt?: number
  queueDroppedCount: number
  acknowledgedSequence: number
  currentSequence: number
  trackingState?: string
  storageBackend?: 'file' | 'database'
  networkMode?: NetworkMode
  modeReason?: string
  profileId?: string
  profileRevision?: number
  lastAcknowledgedAt?: number
  acknowledgementLatencyMs?: number
  reconnectCount?: number
  publishedBytes?: number
}
