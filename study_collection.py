"""Shared participant entry and researcher access for the IE416 study."""
import argparse
from collections import defaultdict
import hashlib
import hmac
import io
import os
from datetime import timedelta
from pathlib import Path
import re
import secrets
from statistics import mean
import tempfile
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

from flask import Flask, abort, jsonify, request, send_file, send_from_directory, session
from waitress import serve

import study_server as study
from study_protocol import load_sa_bank

WEB = study.ROOT / "web" / "study"
EXPORTS = ("summary", "trials", "answers", "events", "json")
SESSION_ID = re.compile(r"[a-f0-9]{16}")
ENROLLMENT_KEY = re.compile(r"[a-f0-9]{32}")
STUDY_MODES = ("pilot", "main")
LOCAL_DATA = study.ROOT / "study-data" / "collection"
TEAM_METRICS = ("sa_primary", "balanced_accuracy", "final_accuracy", "raw_tlx")


def participant_view(current):
    current.pop("summary", None)
    return current


def same_secret(given, expected):
    return isinstance(given, str) and hmac.compare_digest(given.encode(), expected.encode())


def stored_sessions():
    for path in study.DATA.glob("*.json"):
        if SESSION_ID.fullmatch(path.stem):
            record = study.load(path.stem)
            if "collection" in record:
                yield record


def shared_link_secret(directory):
    path = directory / ".shared-link-key"
    if not path.exists():
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as stream:
            temporary = Path(stream.name)
            try:
                stream.write(secrets.token_bytes(32))
                stream.flush()
                os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError("The shared link key is invalid.")
    return key


def team_results():
    groups = defaultdict(list)
    for record in stored_sessions():
        config = record["config"]
        groups[config["mode"], record.get("version", "unknown"), config["condition"]].append(record)

    rows = []
    for (mode, version, condition), records in sorted(groups.items()):
        completed = [study.aggregate(record) for record in records if record["screen"] == "finished"]
        metrics = {}
        for metric in TEAM_METRICS:
            values = [summary[metric] for summary in completed if summary[metric] is not None]
            metrics[metric] = {"mean": mean(values) if values else None, "n": len(values)}
        rows.append({"mode": mode, "version": version, "condition": condition,
                     "total": len(records), "completed": len(completed), "metrics": metrics})
    return rows


def create_app(*, data_dir=None, public_url=None, password=None, viewer_password=None):
    public_url = (public_url or "").rstrip("/")
    if public_url:
        url = urlsplit(public_url)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.path or url.query or url.fragment):
            raise ValueError("IE416_PUBLIC_URL must be an HTTPS origin.")
        if not password or len(password) < 16:
            raise ValueError("Set IE416_ADMIN_PASSWORD to a private password of at least 16 characters.")
        if not data_dir or not Path(data_dir).is_absolute():
            raise ValueError("Set IE416_DATA_DIR to an absolute path on persistent storage.")
        if viewer_password and len(viewer_password) < 16:
            raise ValueError("Set IE416_VIEWER_PASSWORD to a private password of at least 16 characters.")
    else:
        viewer_password = viewer_password or "2222"
    password = password or "1111"
    if viewer_password and same_secret(viewer_password, password):
        raise ValueError("Use different passwords for the admin and viewer accounts.")
    directory = Path(data_dir or LOCAL_DATA).resolve()
    if directory == study.ROOT / "web" or (study.ROOT / "web") in directory.parents:
        raise ValueError("Use a data directory outside the web directory.")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    link_secret = shared_link_secret(directory)
    with study.LOCK:
        study.DATA = directory
        study.SESSIONS.clear()

    app = Flask(__name__, static_folder=None)
    app.config.update(
        SECRET_KEY=secrets.token_hex(32), MAX_CONTENT_LENGTH=131072,
        SESSION_COOKIE_NAME="ie416_research", SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SECURE=bool(public_url), SESSION_COOKIE_SAMESITE="Strict",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=2), SESSION_REFRESH_EACH_REQUEST=False,
    )

    @app.before_request
    def authorize_request():
        if request.method == "POST":
            origin = request.headers.get("Origin")
            if origin and origin != (public_url or request.host_url.rstrip("/")):
                abort(403, "다른 사이트에서 보낸 요청은 처리하지 않습니다.")
            if not request.is_json:
                abort(415, "JSON 요청이 필요합니다.")
        if (request.path.startswith("/api/collection/admin/")
                and request.endpoint != "login" and session.get("researcher") is not True):
            abort(401, "연구자 로그인이 필요합니다.")
        if (request.path.startswith("/api/collection/results/") and request.endpoint != "results_login"
                and not (session.get("researcher") is True or session.get("viewer") is True)):
            abort(401, "팀원 로그인이 필요합니다.")

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        return response

    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(413)
    @app.errorhandler(415)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(ValueError)
    @app.errorhandler(KeyError)
    @app.errorhandler(TypeError)
    @app.errorhandler(OverflowError)
    def bad_request(error):
        return jsonify(error=str(error)), 400

    def body():
        value = request.get_json()
        if not isinstance(value, dict):
            abort(400, "요청 형식을 확인하세요.")
        return value

    def read_record(identifier):
        if SESSION_ID.fullmatch(identifier):
            try:
                record = study.load(identifier)
            except ValueError:
                pass
            else:
                if "collection" in record:
                    return record
        abort(404, "참가 세션을 찾을 수 없습니다.")

    def participant_record(identifier):
        record = read_record(identifier)
        if not same_secret(request.headers.get("Authorization"), "Bearer " + record["token"]):
            abort(403, "이 참가 링크의 인증 정보를 확인하세요.")
        return record

    def invitation(record):
        origin = public_url or request.host_url.rstrip("/")
        return f"{origin}/#join={record['id']}.{record['token']}"

    def link_code(mode):
        return hmac.new(link_secret, mode.encode(), "sha256").hexdigest()

    def session_row(record):
        config = record["config"]
        completed = sum(not item["practice"] for item in record["records"])
        if record["screen"] == "instructions":
            status = "ready" if record["collection"]["acknowledged_utc"] else "invited"
        else:
            status = "finished" if record["screen"] == "finished" else "active"
        return {"id": record["id"], "participant": config["participant"], "mode": config["mode"],
                "condition": config["condition"], "created_utc": record["created_utc"],
                "finished_utc": record.get("finished_utc"), "completed_main": completed, "status": status,
                "legacy_invite": "enrollment_hash" not in record["collection"]}

    @app.get("/")
    def participant_page():
        return send_from_directory(WEB, "index.html")

    @app.get("/admin")
    def admin_page():
        return send_from_directory(WEB, "collection-admin.html")

    @app.get("/results")
    def results_page():
        return send_from_directory(WEB, "collection-results.html")

    @app.get("/study/<name>")
    def asset(name):
        if name not in ("study.js", "study.css", "collection-admin.js", "collection-results.js"):
            abort(404)
        return send_from_directory(WEB, name)

    @app.get("/healthz")
    def health():
        return jsonify(status="ok")

    @app.get("/api/study/protocol")
    def protocol():
        return jsonify(collection=True)

    @app.get("/api/study/map")
    def warehouse():
        return jsonify(study.warehouse_map())

    @app.get("/api/study/sessions/<identifier>")
    def show_trial(identifier):
        with study.LOCK:
            return jsonify(participant_view(study.view(participant_record(identifier))))

    @app.post("/api/study/sessions/<identifier>/action")
    def action(identifier):
        payload = body()
        with study.LOCK:
            record = participant_record(identifier)
            if "enrollment_hash" in record["collection"]:
                payload.pop("notes", None)
            return jsonify(participant_view(study.act(record, payload)))

    @app.post("/api/study/sessions/<identifier>/events")
    def events(identifier):
        payload = body()
        with study.LOCK:
            return jsonify(study.record_events(participant_record(identifier), payload.get("events")))

    def sign_in(username, expected_password, role):
        payload = body()
        if not (payload.get("username") == username and same_secret(payload.get("password"), expected_password)):
            abort(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
        session.clear()
        session.permanent = True
        session[role] = True
        return jsonify(ok=True)

    @app.post("/api/collection/admin/login")
    def login():
        return sign_in("admin", password, "researcher")

    @app.post("/api/collection/results/login")
    def results_login():
        if not viewer_password:
            abort(403, "팀원 로그인이 설정되지 않았습니다.")
        return sign_in("viewer", viewer_password, "viewer")

    @app.post("/api/collection/admin/logout")
    @app.post("/api/collection/results/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/collection/results/summary")
    def results_summary():
        with study.LOCK:
            return jsonify(groups=team_results(), researcher=session.get("researcher") is True)

    @app.get("/api/collection/admin/links")
    def shared_links():
        origin = public_url or request.host_url.rstrip("/")
        return jsonify(links={mode: f"{origin}/#study={mode}.{link_code(mode)}" for mode in STUDY_MODES})

    @app.get("/api/collection/admin/sessions")
    def list_sessions():
        with study.LOCK:
            rows = sorted(map(session_row, stored_sessions()), key=lambda row: row["created_utc"], reverse=True)
        return jsonify(sessions=rows)

    @app.post("/api/collection/enroll")
    def enroll():
        payload = body()
        mode = payload.get("mode")
        if mode not in STUDY_MODES or not same_secret(payload.get("code"), link_code(mode)):
            abort(403, "연구자가 안내한 공용 참가 링크를 확인해 주세요.")
        if payload.get("consent_confirmed") is not True:
            abort(400, "별도 연구 안내 및 동의 절차를 확인하세요.")
        browser_key = payload.get("browser_key")
        if not isinstance(browser_key, str) or not ENROLLMENT_KEY.fullmatch(browser_key):
            abort(400, "이 브라우저에서 참가 세션을 시작할 수 없습니다.")
        enrollment_hash = hashlib.sha256(f"{mode}:{browser_key}".encode()).hexdigest()
        with study.LOCK:
            for record in stored_sessions():
                if record["collection"].get("enrollment_hash") == enrollment_hash:
                    return jsonify(token=record["token"], view=participant_view(study.view(record)))
            config = {"participant": "S-" + secrets.token_hex(8).upper(), "mode": mode}
            record = study.create_session(config, collection=True, enrollment_hash=enrollment_hash)
            return jsonify(token=record["token"], view=participant_view(study.view(record))), 201

    @app.get("/api/collection/admin/sessions/<identifier>/invite")
    def show_invite(identifier):
        with study.LOCK:
            record = read_record(identifier)
            if "enrollment_hash" in record["collection"]:
                abort(404, "이 세션에는 개인 참가 링크가 없습니다.")
            return jsonify(invite=invitation(record))

    @app.get("/api/collection/admin/sessions/<identifier>/<kind>")
    def export_session(identifier, kind):
        if kind not in EXPORTS:
            abort(404)
        with study.LOCK:
            record = read_record(identifier)
            content = study.json_payload(record) if kind == "json" else study.csv_payload(record, kind)
        ext = "json" if kind == "json" else "csv"
        return send_file(io.BytesIO(content), as_attachment=True,
                         download_name=f"ie416-{identifier}-{kind}.{ext}")

    @app.get("/api/collection/admin/backup.zip")
    def download_backup():
        output = io.BytesIO()
        with study.LOCK, ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
            for record in stored_sessions():
                folder = record["id"]
                archive.writestr(f"{folder}/session.json", study.json_payload(record))
                for kind in EXPORTS[:-1]:
                    archive.writestr(f"{folder}/{kind}.csv", study.csv_payload(record, kind))
        output.seek(0)
        return send_file(output, as_attachment=True, download_name="ie416-collection.zip")

    return app


def main():
    parser = argparse.ArgumentParser(description="IE416 response collection server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8767")))
    args = parser.parse_args()
    public_url = os.environ.get("IE416_PUBLIC_URL")
    if not public_url and args.host != "127.0.0.1":
        parser.error("Local mode only binds to 127.0.0.1. Configure IE416_PUBLIC_URL for external hosting.")
    try:
        load_sa_bank()
        app = create_app(data_dir=os.environ.get("IE416_DATA_DIR"), public_url=public_url,
                         password=os.environ.get("IE416_ADMIN_PASSWORD"),
                         viewer_password=os.environ.get("IE416_VIEWER_PASSWORD"))
    except FileNotFoundError:
        parser.error("Set IE416_SA_BANK_PATH to the private protocol/sa_bank_v2.json file.")
    except (OSError, ValueError) as error:
        parser.error(str(error))
    serve(app, host=args.host, port=args.port, threads=4, max_request_body_size=131072)


if __name__ == "__main__":
    main()
