package protocol

import "fmt"

type MessageType byte

const (
	MessageSync      MessageType = 0
	MessageAwareness MessageType = 1
)

// RoomClosed is the WebSocket close code sent to everyone in a room when its
// host leaves. Clients must not reconnect on it: the session is over.
const RoomClosed = 4001

// EncodeMessage prefixes a y-protocols sync/awareness payload with a one-byte message type.
func EncodeMessage(t MessageType, payload []byte) []byte {
	out := make([]byte, 1+len(payload))
	out[0] = byte(t)
	copy(out[1:], payload)
	return out
}

func DecodeMessage(data []byte) (MessageType, []byte, error) {
	if len(data) == 0 {
		return 0, nil, fmt.Errorf("empty message")
	}
	t := MessageType(data[0])
	if t != MessageSync && t != MessageAwareness {
		return 0, nil, fmt.Errorf("unknown message type: %d", data[0])
	}
	return t, data[1:], nil
}
