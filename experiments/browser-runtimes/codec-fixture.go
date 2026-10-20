package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/dolthub/gozstd"
)

func main() {
	var samples [][]byte
	for i := 0; i < 256; i++ {
		samples = append(samples, []byte(fmt.Sprintf(`{"id":"probe-%d","title":"Synthetic browser database issue %d","status":"open","description":"Native compression compatibility fixture"}`, i, i*i)))
	}
	raw := samples[117]
	dict := gozstd.BuildDict(samples, 1024)
	encoder, err := gozstd.NewCDict(dict)
	if err != nil {
		panic(err)
	}
	defer encoder.Release()
	if err := json.NewEncoder(os.Stdout).Encode(map[string][]byte{
		"raw": raw, "compressed": gozstd.Compress(nil, raw),
		"dictionary": dict, "dictionary_compressed": gozstd.CompressDict(nil, raw, encoder),
	}); err != nil {
		panic(err)
	}
}
