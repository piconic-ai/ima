package protocol

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// KeyBytes is the size of a room key (AES-256).
const KeyBytes = 32

// GenerateKey returns a new room key, encoded as base64url for use in a URL fragment.
func GenerateKey() string {
	raw := make([]byte, KeyBytes)
	_, _ = rand.Read(raw) // never fails
	return base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeKey parses a base64url room key.
func DecodeKey(encoded string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("invalid base64url: %w", err)
	}
	if len(raw) != KeyBytes {
		return nil, fmt.Errorf("key must be %d bytes", KeyBytes)
	}
	return raw, nil
}
