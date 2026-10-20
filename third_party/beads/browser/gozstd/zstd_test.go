package gozstd

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func fixture(t *testing.T) map[string][]byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/native.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string][]byte
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestDecodeNativeZstd(t *testing.T) {
	f := fixture(t)
	got, err := Decompress([]byte("prefix:"), f["compressed"])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, append([]byte("prefix:"), f["raw"]...)) {
		t.Fatal("native Zstandard data changed")
	}
}

func TestDecodeNativeDictionary(t *testing.T) {
	f := fixture(t)
	dict, err := NewDDict(f["dictionary"])
	if err != nil {
		t.Fatal(err)
	}
	defer dict.Release()
	got, err := DecompressDict(nil, f["dictionary_compressed"], dict)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, f["raw"]) {
		t.Fatal("native dictionary data changed")
	}
}

func TestRejectCorruptData(t *testing.T) {
	if _, err := Decompress(nil, []byte("not zstd")); err == nil {
		t.Fatal("corrupt data accepted")
	}
}

func TestEncodeWithNativeDictionary(t *testing.T) {
	f := fixture(t)
	encoder, err := NewCDict(f["dictionary"])
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Release()
	decoder, err := NewDDict(f["dictionary"])
	if err != nil {
		t.Fatal(err)
	}
	defer decoder.Release()
	got, err := DecompressDict(nil, CompressDict(nil, f["raw"], encoder), decoder)
	if err != nil || !bytes.Equal(got, f["raw"]) {
		t.Fatalf("dictionary round trip: %v", err)
	}
}
