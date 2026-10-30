package projection

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"

	"github.com/pion/webrtc/v4"
)

const wireJSON byte = 1
const wireFrame byte = 2
const maxWireJSON = 129 * 1024

// Native media IPC is length-prefixed. Raw BGRA never becomes a JSON/base64
// frame or a device signaling message. Only the trusted host opens this pipe.
type MediaMessage struct {
	Type  string                     `json:"type"`
	ID    uint32                     `json:"id,omitempty"`
	SDP   *webrtc.SessionDescription `json:"sdp,omitempty"`
	Data  string                     `json:"data,omitempty"`
	Frame *EncodedFrame              `json:"frame,omitempty"`
	Error string                     `json:"error,omitempty"`
}

func readWire(input io.Reader, maxFrame int) (byte, []byte, error) {
	var buffer []byte
	return readWireBuffer(input, maxFrame, &buffer)
}

func readWireBuffer(input io.Reader, maxFrame int, buffer *[]byte) (byte, []byte, error) {
	var size [4]byte
	if _, err := io.ReadFull(input, size[:]); err != nil {
		return 0, nil, err
	}
	length := binary.BigEndian.Uint32(size[:])
	if length < 1 || uint64(length) > uint64(max(maxWireJSON, maxFrame+8)+1) {
		return 0, nil, errors.New("invalid native media message size")
	}
	var kind [1]byte
	if _, err := io.ReadFull(input, kind[:]); err != nil {
		return 0, nil, err
	}
	if (kind[0] == wireJSON && length-1 > maxWireJSON) ||
		(kind[0] == wireFrame && int(length)-1 != maxFrame+8) ||
		(kind[0] != wireJSON && kind[0] != wireFrame) {
		return 0, nil, errors.New("invalid native media message kind or size")
	}
	sizeNeeded := int(length) - 1
	if cap(*buffer) < sizeNeeded {
		*buffer = make([]byte, sizeNeeded)
	}
	data := (*buffer)[:sizeNeeded]
	_, err := io.ReadFull(input, data)
	return kind[0], data, err
}

func writeWire(output io.Writer, kind byte, data []byte) error {
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(data)+1))
	header[4] = kind
	if err := writeAll(output, header[:]); err != nil {
		return err
	}
	return writeAll(output, data)
}

func writeAll(output io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := output.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func writeMessage(output io.Writer, message MediaMessage) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(data) > maxWireJSON {
		return errors.New("native media response is too large")
	}
	return writeWire(output, wireJSON, data)
}

// The reader borrows one reusable slab until the consumer explicitly returns it.
// An unbuffered channel alone is insufficient: sending completes before encoding.
type incomingWire struct {
	kind    byte
	data    []byte
	err     error
	release chan struct{}
}

func readMediaWires(ctx context.Context, input io.Reader, maxFrame int, wires chan<- incomingWire) {
	var buffer []byte
	for {
		kind, data, err := readWireBuffer(input, maxFrame, &buffer)
		returned := make(chan struct{})
		select {
		case wires <- incomingWire{kind, data, err, returned}:
		case <-ctx.Done():
			return
		}
		select {
		case <-returned:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}
