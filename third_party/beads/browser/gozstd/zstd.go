package gozstd

import "github.com/klauspost/compress/zstd"

type CDict struct{ encoder *zstd.Encoder }
type DDict struct{ decoder *zstd.Decoder }

func Compress(dst, src []byte) []byte {
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		panic(err)
	}
	defer encoder.Close()
	return encoder.EncodeAll(src, dst)
}

func Decompress(dst, src []byte) ([]byte, error) {
	decoder, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
	if err != nil {
		return nil, err
	}
	defer decoder.Close()
	return decoder.DecodeAll(src, dst)
}

func NewCDict(raw []byte) (*CDict, error) {
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderDict(raw), zstd.WithEncoderConcurrency(1))
	return &CDict{encoder}, err
}

func NewDDict(raw []byte) (*DDict, error) {
	decoder, err := zstd.NewReader(nil, zstd.WithDecoderDicts(raw), zstd.WithDecoderConcurrency(1))
	return &DDict{decoder}, err
}

func (dict *CDict) Release() {
	if dict != nil && dict.encoder != nil {
		dict.encoder.Close()
	}
}
func (dict *DDict) Release() {
	if dict != nil && dict.decoder != nil {
		dict.decoder.Close()
	}
}
func CompressDict(dst, src []byte, dict *CDict) []byte {
	if dict == nil {
		return Compress(dst, src)
	}
	return dict.encoder.EncodeAll(src, dst)
}
func DecompressDict(dst, src []byte, dict *DDict) ([]byte, error) {
	if dict == nil {
		return Decompress(dst, src)
	}
	return dict.decoder.DecodeAll(src, dst)
}

func BuildDict(_ [][]byte, _ int) []byte {
	panic("browser probe: archive dictionary training is not implemented")
}
