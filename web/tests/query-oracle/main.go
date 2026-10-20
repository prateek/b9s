package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/vanderheijden86/b9s/pkg/model"
	"github.com/vanderheijden86/b9s/pkg/ui"
)

func main() {
	var input struct {
		Issues    []model.Issue `json:"issues"`
		Queries   []string      `json:"queries"`
		Summaries []string      `json:"summaries"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if input.Summaries != nil {
		result := make([]string, len(input.Summaries))
		for i, text := range input.Summaries {
			result[i] = ui.FirstSentence(text)
		}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	results := make(map[string][]string)
	for _, raw := range input.Queries {
		query := ui.ParseIssueQuery(raw)
		results[raw] = []string{}
		for _, issue := range input.Issues {
			if query.Matches(issue) {
				results[raw] = append(results[raw], issue.ID)
			}
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
