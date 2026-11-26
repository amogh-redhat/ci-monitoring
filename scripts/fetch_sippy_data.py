#!/usr/bin/env python3
"""Fetch OpenShift CI job data from Sippy API and generate static JSON for the dashboard."""

import argparse
import json
import logging
import os
import sys
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone

import requests
from requests.adapters import HTTPAdapter, Retry

SIPPY_BASE_URL = "https://sippy.dptools.openshift.org"
DEFAULT_VERSIONS = ["5.1", "5.0", "4.23", "4.22", "4.21", "4.20", "4.19", "4.18", "4.17", "4.16"]
MAX_FAILING_RUNS = 200
HISTORY_DAYS = 30

log = logging.getLogger("sippy-fetch")


def build_session():
    session = requests.Session()
    retries = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retries)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def fetch_jobs(session, version):
    url = f"{SIPPY_BASE_URL}/api/jobs"
    resp = session.get(url, params={"release": version}, timeout=120)
    resp.raise_for_status()
    return resp.json()


def fetch_failing_runs(session, version):
    url = f"{SIPPY_BASE_URL}/api/jobs/runs"
    filters = json.dumps({
        "items": [{"field": "overall_result", "operator": "equals", "value": "F"}],
        "logicOperator": "and",
    })
    rows = []
    total = None
    offset = 0
    while True:
        params = {
            "release": version,
            "filters": filters,
            "limit": min(MAX_FAILING_RUNS - len(rows), 200),
            "offset": offset,
        }
        resp = session.get(url, params=params, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        total = data.get("total_rows", 0)
        batch = data.get("rows") or []
        if not batch:
            break
        rows.extend(batch)
        if len(rows) >= MAX_FAILING_RUNS:
            break
        offset += len(batch)
        if offset >= total:
            break
    return rows[:MAX_FAILING_RUNS], total


def derive_status(job):
    runs = job.get("current_runs", 0)
    pct = job.get("current_pass_percentage", 0)
    last_pass = job.get("last_pass")
    fails = job.get("current_fails", 0)
    if runs == 0:
        return "NO_RUNS"
    if pct == 100:
        return "PASSING"
    if not last_pass and fails > 0:
        return "NEVER_PASSED"
    return "FAILING"


def derive_trend(net_improvement):
    if net_improvement > 5:
        return "IMPROVING"
    if net_improvement < -5:
        return "DEGRADING"
    return "STABLE"


def process_jobs(raw_jobs):
    processed = []
    for j in raw_jobs:
        processed.append({
            "id": j.get("id"),
            "name": j.get("name", ""),
            "brief_name": j.get("brief_name", ""),
            "variants": j.get("variants") or [],
            "current_pass_percentage": j.get("current_pass_percentage", 0),
            "current_runs": j.get("current_runs", 0),
            "current_passes": j.get("current_passes", 0),
            "current_fails": j.get("current_fails", 0),
            "previous_pass_percentage": j.get("previous_pass_percentage", 0),
            "previous_runs": j.get("previous_runs", 0),
            "previous_passes": j.get("previous_passes", 0),
            "previous_fails": j.get("previous_fails", 0),
            "net_improvement": j.get("net_improvement", 0),
            "current_average_duration_minutes": j.get("current_average_duration_minutes", 0),
            "previous_average_duration_minutes": j.get("previous_average_duration_minutes", 0),
            "last_pass": j.get("last_pass"),
            "open_bugs": j.get("open_bugs", 0),
            "test_grid_url": j.get("test_grid_url", ""),
            "status": derive_status(j),
            "trend": derive_trend(j.get("net_improvement", 0)),
        })
    return processed


def compute_summary(processed_jobs):
    total = len(processed_jobs)
    passing = sum(1 for j in processed_jobs if j["status"] == "PASSING")
    failing = sum(1 for j in processed_jobs if j["status"] in ("FAILING", "NEVER_PASSED"))
    other = total - passing - failing
    durations = [j["current_average_duration_minutes"] for j in processed_jobs if j["current_average_duration_minutes"] > 0]
    avg_dur = round(sum(durations) / len(durations), 1) if durations else 0
    total_runs_current = sum(j["current_runs"] for j in processed_jobs)
    total_runs_previous = sum(j["previous_runs"] for j in processed_jobs)
    pass_rate = round((passing / total) * 100, 2) if total > 0 else 0
    return {
        "total_jobs": total,
        "passing_jobs": passing,
        "failing_jobs": failing,
        "other_jobs": other,
        "pass_rate": pass_rate,
        "avg_duration_minutes": avg_dur,
        "total_runs_current": total_runs_current,
        "total_runs_previous": total_runs_previous,
    }


def process_runs(raw_runs, total_failing):
    runs = []
    infra_count = 0
    test_failure_count = 0
    unknown_count = 0
    test_counter = Counter()

    for r in raw_runs:
        is_infra = r.get("infrastructure_failure", False)
        test_fails = r.get("test_failures", 0)
        failed_tests = r.get("failed_test_names") or []

        if is_infra:
            infra_count += 1
        elif test_fails > 0:
            test_failure_count += 1
        else:
            unknown_count += 1

        for t in failed_tests:
            test_counter[t] += 1

        runs.append({
            "id": str(r.get("prow_id", r.get("id", ""))),
            "job": r.get("job", ""),
            "brief_name": r.get("brief_name", ""),
            "cluster": r.get("cluster", ""),
            "timestamp": r.get("timestamp", ""),
            "overall_result": r.get("overall_result", ""),
            "infrastructure_failure": is_infra,
            "known_failure": r.get("known_failure", False),
            "test_failures": test_fails,
            "failed_test_names": failed_tests,
            "url": r.get("url", ""),
        })

    top_tests = [{"name": name, "count": count} for name, count in test_counter.most_common(50)]

    return {
        "total_failing_runs": total_failing,
        "runs": runs,
        "failure_categories": {
            "infrastructure": infra_count,
            "test_failure": test_failure_count,
            "unknown": unknown_count,
        },
        "top_failing_tests": top_tests,
    }


def update_history(output_dir, version_summaries):
    history_path = os.path.join(output_dir, "history.json")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    history = {"snapshots": []}
    if os.path.exists(history_path):
        try:
            with open(history_path, "r") as f:
                history = json.load(f)
        except (json.JSONDecodeError, IOError):
            history = {"snapshots": []}

    snapshots = [s for s in history["snapshots"] if s.get("date") != today]

    today_snapshot = {"date": today, "versions": {}}
    for version, summary in version_summaries.items():
        today_snapshot["versions"][version] = {
            "total_jobs": summary["total_jobs"],
            "pass_rate": summary["pass_rate"],
            "failing_jobs": summary["failing_jobs"],
            "infrastructure_failures": summary.get("infrastructure_failures", 0),
        }

    snapshots.append(today_snapshot)
    snapshots.sort(key=lambda s: s["date"], reverse=True)
    snapshots = snapshots[:HISTORY_DAYS]

    history["snapshots"] = snapshots
    return history


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def main():
    parser = argparse.ArgumentParser(description="Fetch Sippy CI data for OpenShift dashboard")
    parser.add_argument("--output-dir", default="docs/data", help="Output directory for JSON files")
    parser.add_argument("--versions", nargs="+", default=DEFAULT_VERSIONS, help="Versions to fetch")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    output_dir = args.output_dir
    versions = args.versions
    now = datetime.now(timezone.utc).isoformat()

    session = build_session()
    version_summaries = {}
    all_good = True

    log.info("Starting Sippy data fetch for versions: %s", ", ".join(versions))

    for version in versions:
        log.info("[%s] Fetching job summaries...", version)
        try:
            raw_jobs = fetch_jobs(session, version)
        except requests.RequestException as e:
            log.error("[%s] Failed to fetch jobs: %s", version, e)
            all_good = False
            continue

        processed_jobs = process_jobs(raw_jobs)
        summary = compute_summary(processed_jobs)

        version_data = {
            "version": version,
            "last_updated": now,
            "jobs": processed_jobs,
        }
        write_json(os.path.join(output_dir, f"{version}.json"), version_data)
        log.info("[%s] Wrote %d jobs", version, len(processed_jobs))

        log.info("[%s] Fetching failing runs...", version)
        try:
            raw_runs, total_failing = fetch_failing_runs(session, version)
        except requests.RequestException as e:
            log.error("[%s] Failed to fetch runs: %s", version, e)
            raw_runs, total_failing = [], 0
            all_good = False

        runs_data = process_runs(raw_runs, total_failing)
        runs_data["version"] = version
        runs_data["last_updated"] = now
        summary["infrastructure_failures"] = runs_data["failure_categories"]["infrastructure"]
        write_json(os.path.join(output_dir, "runs", f"{version}.json"), runs_data)
        log.info("[%s] Wrote %d failing runs (total: %d)", version, len(raw_runs), total_failing)

        version_summaries[version] = summary

    versions_data = {
        "last_updated": now,
        "versions": versions,
        "summary": version_summaries,
    }
    write_json(os.path.join(output_dir, "versions.json"), versions_data)
    log.info("Wrote versions.json")

    history = update_history(output_dir, version_summaries)
    write_json(os.path.join(output_dir, "history.json"), history)
    log.info("Updated history.json (%d snapshots)", len(history["snapshots"]))

    if all_good:
        log.info("Done — all versions fetched successfully.")
    else:
        log.warning("Done — some versions had errors, check logs above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
