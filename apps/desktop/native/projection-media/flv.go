package projection

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

const maxEncodedTag = 4 * 1024 * 1024

// FLV is only length framing on the private FFmpeg stdout pipe, not a network
// transport. A raw Annex-B stream needs the NEXT start code to finish its final
// NAL, which would deadlock our one-frame-in-flight source. FLV gives each AVC
// access unit an explicit size, including frames larger than a PES packet.
func readEncodedFrames(input io.Reader, emit func([]byte) error) error {
	var header [13]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return err
	}
	if !bytes.Equal(header[:3], []byte("FLV")) || header[3] != 1 || header[4] != 1 || binary.BigEndian.Uint32(header[5:9]) != 9 || binary.BigEndian.Uint32(header[9:]) != 0 {
		return errors.New("invalid encoder FLV header")
	}
	var tag [11]byte
	var previous [4]byte
	var parameterSets []byte
	lengthSize := 0
	for {
		if _, err := io.ReadFull(input, tag[:]); err != nil {
			return err
		}
		size := int(tag[1])<<16 | int(tag[2])<<8 | int(tag[3])
		if size > maxEncodedTag || tag[8] != 0 || tag[9] != 0 || tag[10] != 0 {
			return errors.New("invalid encoder FLV tag size or stream")
		}
		data := make([]byte, size)
		if _, err := io.ReadFull(input, data); err != nil {
			return err
		}
		if _, err := io.ReadFull(input, previous[:]); err != nil {
			return err
		}
		if binary.BigEndian.Uint32(previous[:]) != uint32(size+11) {
			return errors.New("invalid encoder FLV tag boundary")
		}
		if tag[0] == 18 {
			continue
		} // bounded stream metadata, never media or input
		if tag[0] != 9 || len(data) < 5 || data[0]&15 != 7 || (data[0]>>4 != 1 && data[0]>>4 != 2) || data[2] != 0 || data[3] != 0 || data[4] != 0 {
			return errors.New("encoder did not emit baseline AVC video")
		}
		switch data[1] {
		case 0:
			var err error
			lengthSize, parameterSets, err = avcParameterSets(data[5:])
			if err != nil {
				return err
			}
		case 1:
			if lengthSize == 0 {
				return errors.New("AVC frame preceded its configuration")
			}
			annexB := make([]byte, 0, len(data)+len(parameterSets))
			if data[0]>>4 == 1 {
				annexB = append(annexB, parameterSets...)
			}
			body := data[5:]
			vcl := false
			for len(body) > 0 {
				if len(body) < lengthSize {
					return errors.New("truncated AVC NAL size")
				}
				length := 0
				for _, b := range body[:lengthSize] {
					length = length<<8 | int(b)
				}
				body = body[lengthSize:]
				if length <= 0 || length > len(body) {
					return errors.New("invalid AVC NAL boundary")
				}
				kind := body[0] & 31
				vcl = vcl || kind == 1 || kind == 5
				annexB = append(annexB, 0, 0, 0, 1)
				annexB = append(annexB, body[:length]...)
				body = body[length:]
			}
			if !vcl {
				return errors.New("encoded access unit contains no video slice")
			}
			if err := emit(annexB); err != nil {
				return err
			}
		case 2: // normal sequence end; process exit decides whether expected
		default:
			return errors.New("invalid AVC packet type")
		}
	}
}

func avcParameterSets(data []byte) (int, []byte, error) {
	invalid := errors.New("invalid AVC configuration")
	if len(data) < 7 || data[0] != 1 || data[1] != 66 {
		return 0, nil, invalid
	}
	lengthSize := int(data[4]&3) + 1
	if lengthSize == 3 {
		return 0, nil, invalid
	}
	sps := int(data[5] & 31)
	if sps == 0 {
		return 0, nil, invalid
	}
	data = data[6:]
	var sets []byte
	for group := 0; group < 2; group++ {
		count := sps
		if group == 1 {
			if len(data) < 1 || data[0] == 0 {
				return 0, nil, invalid
			}
			count, data = int(data[0]), data[1:]
		}
		for index := 0; index < count; index++ {
			if len(data) < 2 {
				return 0, nil, invalid
			}
			size := int(binary.BigEndian.Uint16(data))
			data = data[2:]
			if size == 0 || size > len(data) || (group == 0 && data[0]&31 != 7) || (group == 1 && data[0]&31 != 8) {
				return 0, nil, invalid
			}
			sets = append(sets, 0, 0, 0, 1)
			sets = append(sets, data[:size]...)
			data = data[size:]
		}
	}
	if len(data) != 0 {
		return 0, nil, invalid
	}
	return lengthSize, sets, nil
}
