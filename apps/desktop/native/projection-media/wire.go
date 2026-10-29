package projection

import (
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
	data := make([]byte, int(length)-1)
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
