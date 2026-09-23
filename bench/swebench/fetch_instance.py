#!/usr/bin/env python3
"""Prints one SWE-bench Verified instance's full row as JSON to stdout.

Deterministic: same instance_id + same dataset always returns the same
content, so this is safe to call fresh per run rather than caching the full
problem_statement/test_patch text in instances.json (which only stores the
stratification columns per the pre-registration doc).

Usage: python3 fetch_instance.py <instance_id>
"""
import json
import sys

from datasets import load_dataset

instance_id = sys.argv[1]
ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
row = next(r for r in ds if r["instance_id"] == instance_id)
print(json.dumps(dict(row)))
