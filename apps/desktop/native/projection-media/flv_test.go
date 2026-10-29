package projection

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func flvTestTag(kind byte, data []byte) []byte {
	out := make([]byte, 11+len(data)+4)
	out[0] = kind
	out[1], out[2], out[3] = byte(len(data)>>16), byte(len(data)>>8), byte(len(data))
	copy(out[11:], data)
	binary.BigEndian.PutUint32(out[len(out)-4:], uint32(11+len(data)))
	return out
}

func TestEncodedPipeHasExplicitAccessUnitBoundaries(t *testing.T) {
	header := []byte{'F', 'L', 'V', 1, 1, 0, 0, 0, 9, 0, 0, 0, 0}
	config := []byte{0x17, 0, 0, 0, 0, 1, 66, 0, 31, 255, 225, 0, 2, 0x67, 1, 1, 0, 2, 0x68, 2}
	frame := []byte{0x17, 1, 0, 0, 0, 0, 0, 0, 3, 0x65, 3, 4}
	stream := append(header, flvTestTag(9, config)...)
	stream = append(stream, flvTestTag(9, frame)...)
	var got [][]byte
	err := readEncodedFrames(bytes.NewReader(stream), func(data []byte) error { got = append(got, bytes.Clone(data)); return nil })
	if !errors.Is(err, io.EOF) || len(got) != 1 {
		t.Fatalf("one frame did not finish without a following NAL: %d %v", len(got), err)
	}
	if !bytes.Equal(got[0], []byte{0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 3, 4}) {
		t.Fatalf("AVCC/Annex-B association changed: %x", got[0])
	}
	for _, bad := range [][]byte{
		append(bytes.Clone(header), []byte{9, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0}...),
		stream[:len(stream)-1],
		append(append(bytes.Clone(header), flvTestTag(9, config)...), flvTestTag(9, []byte{0x17, 1, 0, 0, 0, 0, 0, 0, 255, 0x65})...),
	} {
		if err = readEncodedFrames(bytes.NewReader(bad), func([]byte) error { return nil }); err == nil || errors.Is(err, io.EOF) {
			t.Fatalf("malformed encoded pipe admitted: %v", err)
		}
	}
}
