"""Local IE416 study server. Reuses the warehouse geometry, not AMR KPI logic."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from datetime import datetime, timezone
import argparse
import csv
import hmac
import io
import json
import math
import os
import random
import re
import secrets
import tempfile
import threading
import time
import uuid
from study_protocol import VERSION, build_deck, bank_hash, public_stimulus, protocol_spec, aggregate, outcomes, warehouse_map, sa_bank_metadata, translate_demo

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "study-data"
LOCK = threading.RLock()
SESSIONS = {}


def utc():
    return datetime.now(timezone.utc).isoformat()


def save(session):
    tmp = None
    try:
        DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".tmp",
                                         dir=DATA, delete=False) as stream:
            tmp = Path(stream.name)
            json.dump(session, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, DATA / (session["id"] + ".json"))
    except (OSError, ValueError):
        SESSIONS.pop(session["id"], None)
        raise
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


def load(identifier):
    if not re.fullmatch(r"[a-f0-9]{16}", identifier):
        raise ValueError("Invalid session id")
    if identifier not in SESSIONS:
        path = DATA / (identifier + ".json")
        if not path.exists():
            raise ValueError("세션을 찾을 수 없습니다.")
        SESSIONS[identifier] = json.loads(path.read_text(encoding="utf-8"))
    return SESSIONS[identifier]


def log(session, name, details=None):
    active = session.get("active")
    session["events"].append({"event": name, "server_utc": utc(), "server_epoch_ms": time.time() * 1000,
                              "trial": active["scenario_id"] if active else None, "details": details or {}})


def validate_config(body):
    participant = str(body.get("participant", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", participant):
        raise ValueError("참가자 코드는 영문·숫자·밑줄·하이픈 1~32자로 입력하세요.")
    mode = body.get("mode", "pilot")
    if mode not in ("demo", "pilot", "main"):
        raise ValueError("Unknown mode")
    language = body.get("language", "ko")
    if language not in ("ko", "en"):
        raise ValueError("Unknown language")
    if language == "en" and mode != "demo":
        raise ValueError("English is available in demo mode.")
    condition = body.get("condition", "auto")
    if condition not in ("auto", "table", "node"):
        raise ValueError("Unknown UI condition")
    result = {"participant": participant, "mode": mode, "condition": condition, "language": language}
    for key, default, minimum, maximum in [("seed", 416, 0, 2**31 - 1), ("prelude_s", 4, 1, 30),
                                           ("review_s", 20, 1 if mode == "demo" else 5, 120),
                                           ("question_s", 25, 3 if mode == "demo" else 10, 120),
                                           ("decision_s", 90, 5 if mode == "demo" else 20, 300)]:
        value = body.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value:
            raise ValueError(f"Invalid {key}")
        if not minimum <= value <= maximum:
            raise ValueError(f"{key}: {minimum}~{maximum}")
        result[key] = int(value)
    return result


def create_session(body, *, collection=False, enrollment_hash=None):
    config = validate_config(body)
    if config["condition"] == "auto":
        counts = {"table": 0, "node": 0}
        for path in DATA.glob("*.json") if DATA.exists() else []:
            try:
                prior = json.loads(path.read_text(encoding="utf-8"))
                if (prior["config"]["mode"] == config["mode"] and prior.get('version') == VERSION
                        and prior["config"].get("language", "ko") == config["language"]):
                    counts[prior["config"]["condition"]] += 1
            except (ValueError, KeyError):
                continue
        candidates = [k for k, v in counts.items() if v == min(counts.values())]
        config["condition"] = secrets.choice(candidates)
    deck = build_deck(config["seed"], config["mode"] == "demo")
    if config["language"] == "en":
        translate_demo(deck)
    session = {"id": uuid.uuid4().hex[:16], "token": secrets.token_urlsafe(24), "version": VERSION,
               "created_utc": utc(), "config": config, "deck": deck, "bank_sha256": bank_hash(deck),
               **sa_bank_metadata(),
               "map_sha256": warehouse_map()["sha256"], "map_source": "synthetic-ie416",
               "screen": "instructions", "index": 0, "active": None, "records": [], "events": [],
               "survey": {}, "requests": {}}
    if collection:
        session["collection"] = {"acknowledged_utc": utc() if enrollment_hash else None}
        if enrollment_hash:
            session["collection"]["enrollment_hash"] = enrollment_hash
    log(session, "session_created", {"config": config})
    if enrollment_hash:
        log(session, "consent_procedure_acknowledged")
    save(session)
    SESSIONS[session["id"]] = session
    return session


def begin_trial(session):
    if session["index"] >= len(session["deck"]):
        session["screen"] = "survey"
        session["active"] = None
        log(session, "survey_open")
        return
    scenario = session["deck"][session["index"]]
    now = time.time()
    active = {"scenario_id": scenario["id"], "started": now,
              "event_at": now + session["config"]["prelude_s"],
              "review_end": now + session["config"]["prelude_s"] + session["config"]["review_s"],
              "question_index": 0, "question_started": None, "answers": [], "judgment": None,
              "judgment_at": None, "judgment_client_ms": None, "complete": False,
              "interrupted": False, "marker_sent": False}
    session["active"] = active
    session["screen"] = "trial"
    log(session, "trial_start", {"purpose": scenario["purpose"], "kind": scenario["kind"],
                                 "event_epoch_ms": active["event_at"] * 1000,
                                 "review_end_epoch_ms": active["review_end"] * 1000,
                                 "practice": scenario["practice"]})


def phase(session, now=None):
    if session["screen"] != "trial":
        return session["screen"]
    a = session["active"]
    if a["complete"]:
        return "trial_done"
    now = now if now is not None else time.time()
    if now < a["event_at"]:
        return "prelude"
    if now < a["review_end"]:
        return "review"
    scenario = session["deck"][session["index"]]
    return "question" if scenario["purpose"] == "sa" else "decision" if a["judgment"] is None else "reorder"


def finish_trial(session, final_order=None, timeout=False, client_ms=None):
    a = session["active"]
    if a["complete"]:
        return
    s = session["deck"][session["index"]]
    now = time.time()
    record = {"scenario_id": s["id"], "sa_bank_id": s.get('bank_id'),
              "purpose": s["purpose"], "kind": s["kind"], "subtype": s["subtype"],
              "practice": s["practice"], "valid": s["valid"], "answers": a["answers"],
              "judgment": a["judgment"], "final_order": final_order, "timeout": timeout,
              "final_correct": final_order in s["feasible_orders"] if final_order else False,
              "judgment_correct": (a["judgment"] == ("keep" if s["valid"] else "change")),
              "judgment_rt_ms": (a["judgment_at"] - a["event_at"]) * 1000 if a["judgment_at"] else None,
              "judgment_after_review_ms": (a["judgment_at"] - a["review_end"]) * 1000 if a["judgment_at"] else None,
              "final_rt_ms": (now - a["event_at"]) * 1000,
              "client_judgment_epoch_ms": a["judgment_client_ms"], "client_final_epoch_ms": client_ms,
              "event_epoch_ms": a["event_at"] * 1000, "review_end_epoch_ms": a["review_end"] * 1000,
              "completed_utc": utc(), "interrupted": a["interrupted"]}
    if s["purpose"] == "sa":
        record["final_correct"] = None
        record["judgment_correct"] = None
    session["records"].append(record)
    a["complete"] = True
    log(session, "trial_complete", {"timeout": timeout})


def open_question(session):
    a = session["active"]
    if a["question_started"] is None:
        a["question_started"] = time.time()
        log(session, "question_open", {"index": a["question_index"]})


def answer_question(session, answer, client_ms=None):
    a = session["active"]
    s = session["deck"][session["index"]]
    q = s["questions"][a["question_index"]]
    options = {o["id"] for o in q["options"]}
    if answer is not None and answer not in options:
        raise ValueError("Invalid answer option")
    timed_out = time.time() >= a["question_started"] + session["config"]["question_s"]
    if timed_out:
        answer = None
    a["answers"].append({"index": a["question_index"], "level": q["level"], "subtype": q["subtype"],
                         "prompt": q['prompt'],
                         "chosen_text": next((o['text'] for o in q['options'] if o['id'] == answer), None),
                         "correct_text": next(o['text'] for o in q['options'] if o['id'] == q['correct']),
                         "answer": answer, "correct_answer": q["correct"], "correct": answer == q["correct"],
                         "rt_ms": (time.time() - a["question_started"]) * 1000, "timeout": answer is None,
                         "client_epoch_ms": client_ms})
    log(session, "question_answer", {"index": a["question_index"], "answer": answer})
    a["question_index"] += 1
    a["question_started"] = None
    if a["question_index"] >= 3:
        finish_trial(session, timeout=any(x["timeout"] for x in a["answers"]))
    else:
        open_question(session)


def view(session):
    now = time.time()
    current_phase = phase(session, now)
    base = {"id": session["id"], "config": session["config"], "phase": current_phase,
            "server_epoch_ms": now * 1000, "protocol_version": session.get('version', VERSION),
            "legacy_protocol": session.get('version') != VERSION,
            "sa_bank_version": session.get('sa_bank_version'),
            "completed_main": sum(not r["practice"] for r in session["records"]),
            "total_main": 6 if session["config"]["mode"] == "demo" else 36,
            "completed_practice": sum(r["practice"] for r in session["records"]),
            "total_practice": 0 if session["config"]["mode"] == "demo" else 4}
    if "collection" in session:
        base["consent_required"] = not session["collection"]["acknowledged_utc"]
    if current_phase == "finished":
        base["summary"] = aggregate(session)
    if session["screen"] != "trial":
        return base
    a, s = session["active"], session["deck"][session["index"]]
    base.update(trial_id=s["id"], practice=s["practice"],
                event_epoch_ms=a["event_at"] * 1000, review_end_epoch_ms=a["review_end"] * 1000)
    if current_phase in ("prelude", "review", "decision", "reorder"):
        base["stimulus"] = public_stimulus(s, current_phase != "prelude")
    if current_phase in ("decision", "reorder"):
        base["judgment"] = a["judgment"]
        base["decision_end_epoch_ms"] = (a["review_end"] + session["config"]["decision_s"]) * 1000
        if now >= base["decision_end_epoch_ms"] / 1000:
            finish_trial(session, timeout=True)
            save(session)
            return view(session)
    if current_phase == "question":
        if not a["marker_sent"]:
            log(session, "scheduled_occlusion", {"scheduled_epoch_ms": a["review_end"] * 1000})
            a["marker_sent"] = True
        open_question(session)
        q = s["questions"][a["question_index"]]
        base["question"] = {k: q[k] for k in ("prompt", "options")}
        base["question_index"] = a["question_index"]
        base["question_end_epoch_ms"] = (a["question_started"] + session["config"]["question_s"]) * 1000
        save(session)
    if current_phase == "trial_done" and s["practice"]:
        r = session["records"][-1]
        base["practice_feedback"] = {"correct": r["final_correct"] and r["judgment_correct"],
                                     "suitable": s["valid"], "feasible_orders": s["feasible_orders"],
                                     "rows": outcomes(s["recommendation"], s["current"]["durations"], s["current"]["deadlines"])}
    return base


def act(session, body):
    action = body.get("action")
    key = body.get("request_id")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", key):
        raise ValueError("request_id required")
    if key in session["requests"]:
        return view(session)
    current_phase = phase(session)
    a = session.get("active")
    if a and body.get("trial_id") != a["scenario_id"]:
        raise ValueError("Trial changed. Reload current state.")
    if current_phase in ("decision", "reorder") and time.time() >= a["review_end"] + session["config"]["decision_s"]:
        finish_trial(session, timeout=True)
        session["requests"][key] = "expired"
        save(session)
        return view(session)
    client_ms = body.get("client_epoch_ms")
    if client_ms is not None and (not isinstance(client_ms, (int, float)) or not math.isfinite(client_ms)):
        raise ValueError("Invalid client timestamp")
    if action == "start" and current_phase == "instructions":
        if "collection" in session and not session["collection"]["acknowledged_utc"]:
            if body.get("consent_confirmed") is not True:
                raise ValueError("별도 연구 안내 및 동의 절차를 확인하세요.")
            session["collection"]["acknowledged_utc"] = utc()
            log(session, "consent_procedure_acknowledged")
        begin_trial(session)
    elif action == "continue" and current_phase == "break":
        begin_trial(session)
    elif action == "answer" and current_phase == "question":
        open_question(session)
        if body.get("question_index") != a["question_index"]:
            raise ValueError("Question changed. Reload current state.")
        answer_question(session, body.get("answer"), client_ms)
    elif action == "judge" and current_phase == "decision":
        if body.get("judgment") not in ("keep", "change"):
            raise ValueError("Choose keep or change")
        a["judgment"], a["judgment_at"], a["judgment_client_ms"] = body["judgment"], time.time(), client_ms
        log(session, "suitability_judgment", {"choice": body["judgment"], "client_epoch_ms": client_ms})
    elif action == "confirm" and current_phase == "reorder":
        order = body.get("order")
        if not isinstance(order, list) or sorted(order) != ["A", "B", "C"]:
            raise ValueError("Choose a valid permutation")
        expired = time.time() >= a["review_end"] + session["config"]["decision_s"]
        finish_trial(session, None if expired else order, timeout=expired, client_ms=client_ms)
    elif action == "next" and current_phase == "trial_done":
        s = session["deck"][session["index"]]
        session["index"] += 1
        completed = sum(not r["practice"] for r in session["records"])
        if not s["practice"] and completed in (12, 24) and session["index"] < len(session["deck"]):
            session["screen"], session["active"] = "break", None
            log(session, "break_open")
        else:
            begin_trial(session)
    elif action == "survey" and current_phase == "survey":
        values = body.get("tlx")
        names = ["mental", "physical", "temporal", "performance", "effort", "frustration"]
        if not isinstance(values, dict) or set(values) != set(names):
            raise ValueError("Complete all six workload items")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 100 for v in values.values()):
            raise ValueError("Workload ratings must be between 0 and 100")
        session["survey"] = {"tlx": values, "raw_tlx": sum(values.values()) / 6,
                             "scoring": "unweighted Raw TLX; performance 0=perfect,100=failure",
                             "notes": str(body.get("notes", ""))[:2000]}
        session["screen"] = "finished"
        session["finished_utc"] = utc()
        log(session, "session_finished")
    else:
        raise ValueError("현재 단계에서 사용할 수 없는 동작입니다. 화면을 새로고침하세요.")
    session["requests"][key] = action
    save(session)
    return view(session)


def csv_payload(session, kind):
    rows = []
    if kind == "summary":
        rows = [aggregate(session)]
    elif kind == "trials":
        for r in session["records"]:
            rows.append({"session_id": session["id"], "participant": session["config"]["participant"],
                         "condition": session["config"]["condition"], "mode": session["config"]["mode"],
                         "protocol_version": session.get('version'), "sa_bank_version": session.get('sa_bank_version'),
                         **{k: v for k, v in r.items() if k != "answers"},
                         "final_order": "".join(r["final_order"] or []),
                         "sa_correct": sum(a["correct"] for a in r.get("answers", [])),
                         "sa_total": len(r.get("answers", []))})
    elif kind == "answers":
        for r in session["records"]:
            for a in r.get("answers", []):
                rows.append({"session_id": session["id"], "participant": session['config']['participant'],
                             "mode": session['config']['mode'], "condition": session["config"]["condition"],
                             "protocol_version": session.get('version'), "sa_bank_version": session.get('sa_bank_version'),
                             "scenario_id": r["scenario_id"], "sa_bank_id": r.get('sa_bank_id'),
                             "practice": r["practice"], **a})
    elif kind == "events":
        rows = [{**e, "details": json.dumps(e["details"], ensure_ascii=False)} for e in session["events"]]
    else:
        raise ValueError("Unknown export")
    stream = io.StringIO()
    keys = list(dict.fromkeys(k for r in rows for k in r)) or ["session_id"]
    writer = csv.DictWriter(stream, fieldnames=keys)
    writer.writeheader()
    for row in rows:
        # Literal values only, never spreadsheet formulas from free-text fields.
        safe = {k: ("'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v) for k, v in row.items()}
        writer.writerow(safe)
    return ("\ufeff" + stream.getvalue()).encode("utf-8")


def json_payload(session):
    data = {key: value for key, value in session.items() if key != "token"}
    if "collection" in data:
        data["collection"] = {key: value for key, value in data["collection"].items()
                              if key != "enrollment_hash"}
    return json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False).encode()


def record_events(session, events):
    if (not isinstance(events, list) or len(events) > 100
            or any(not isinstance(e, dict) or not isinstance(e.get("event"), str) for e in events)):
        raise ValueError("Invalid event batch")
    if len(session["events"]) + len(events) > 20000:
        raise ValueError("Event limit reached")
    json.dumps(events, allow_nan=False)
    for e in events:
        log(session, "client_" + e["event"][:64], {k: v for k, v in e.items() if k != "event"})
        if e["event"] in ("hidden", "reload") and session.get("active") and not session["active"]["complete"]:
            session["active"]["interrupted"] = True
    save(session)
    return {"saved": len(events)}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def send_data(self, payload, content_type, status=200, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, value, status=200):
        self.send_data(json.dumps(value, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8", status)

    def authorized(self, identifier):
        session = load(identifier)
        header = self.headers.get("Authorization", "")
        if not hmac.compare_digest(header, "Bearer " + session["token"]):
            raise PermissionError("세션 인증 정보가 필요합니다.")
        return session

    def do_GET(self):
        route = urlparse(self.path).path
        try:
            if route == "/":
                self.path = "/study/index.html"
                return super().do_GET()
            if route == "/api/study/protocol":
                return self.send_json(protocol_spec())
            if route == "/api/study/map":
                return self.send_json(warehouse_map())
            match = re.fullmatch(r"/api/study/sessions/([a-f0-9]{16})(?:/(summary|trials|answers|events|json))?", route)
            if match:
                with LOCK:
                    session = self.authorized(match[1])
                    export = match[2]
                    if not export:
                        return self.send_json(view(session))
                    if export == "json":
                        return self.send_data(json_payload(session), "application/json", filename=f"ie416-{session['id']}.json")
                    return self.send_data(csv_payload(session, export), "text/csv; charset=utf-8", filename=f"ie416-{session['id']}-{export}.csv")
            if route.startswith("/api/"):
                return self.send_json({"error": "Not found"}, 404)
            return super().do_GET()
        except PermissionError as exc:
            return self.send_json({"error": str(exc)}, 403)
        except (ValueError, KeyError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def do_POST(self):
        route = urlparse(self.path).path
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            return self.send_json({"error": "Cross-origin request rejected"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 131072:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Expected an object")
            with LOCK:
                if route == "/api/study/sessions":
                    session = create_session(body)
                    return self.send_json({"token": session["token"], "view": view(session)}, 201)
                match = re.fullmatch(r"/api/study/sessions/([a-f0-9]{16})/(action|events)", route)
                if not match:
                    return self.send_json({"error": "Not found"}, 404)
                session = self.authorized(match[1])
                if match[2] == "action":
                    return self.send_json(act(session, body))
                return self.send_json(record_events(session, body.get("events")))
        except PermissionError as exc:
            return self.send_json({"error": str(exc)}, 403)
        except (ValueError, KeyError, TypeError, OverflowError) as exc:
            return self.send_json({"error": str(exc)}, 400)


def main():
    parser = argparse.ArgumentParser(description="IE416 local supervisory UI experiment")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    service = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"IE416 Supervision Lab — http://127.0.0.1:{args.port}/", flush=True)
    try:
        service.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.server_close()


if __name__ == "__main__":
    main()
