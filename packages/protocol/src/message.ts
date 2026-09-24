export const MessageType = {
  Sync: 0,
  Awareness: 1,
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export interface Message {
  type: MessageType
  payload: Uint8Array
}

/** Prefixes a y-protocols sync/awareness payload with a one-byte message type. */
export function encodeMessage(type: MessageType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length)
  out[0] = type
  out.set(payload, 1)
  return out
}

export function decodeMessage(data: Uint8Array): Message {
  const type = data[0]
  if (type !== MessageType.Sync && type !== MessageType.Awareness) {
    throw new Error(`unknown message type: ${type}`)
  }
  return { type, payload: data.subarray(1) }
}
