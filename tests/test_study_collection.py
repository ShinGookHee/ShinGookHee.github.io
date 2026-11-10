import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
from zipfile import ZipFile

import study_server as study

COLLECTION_INSTALLED = all(importlib.util.find_spec(name) for name in ("flask", "waitress"))


@unittest.skipUnless(COLLECTION_INSTALLED, "Install requirements-collection.txt to test collection.")
class CollectionTests(unittest.TestCase):
    def setUp(self):
        from study_collection import create_app

        self.create_app = create_app
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.addCleanup(study.SESSIONS.clear)
        original = study.DATA
        self.addCleanup(setattr, study, "DATA", original)
        self.data = Path(temp.name)
        self.app = self.create_app(data_dir=self.data)
        self.admin = self.app.test_client()
        self.participant = self.app.test_client()

    def login(self, admin):
        return admin.post("/api/collection/admin/login", json={"username": "admin", "password": "1111"})

    def shared_link(self, admin, mode="pilot"):
        response = admin.get("/api/collection/admin/links")
        self.assertEqual(response.status_code, 200)
        return response.json["links"][mode]

    def enroll(self, link, key, **extra):
        mode, code = urlsplit(link).fragment.removeprefix("study=").split(".")
        return self.participant.post("/api/collection/enroll", json={
            "mode": mode, "code": code, "consent_confirmed": True, "browser_key": key, **extra
        })

    def test_access_and_fixed_assignment(self):
        self.assertEqual(self.participant.get("/api/collection/admin/sessions").status_code, 401)
        self.assertEqual(self.participant.get("/api/collection/admin/backup.zip").status_code, 401)
        self.assertEqual(self.participant.get("/api/collection/admin/links").status_code, 401)
        self.assertEqual(self.participant.get("/api/collection/results/summary").status_code, 401)
        self.assertEqual(self.participant.post("/api/study/sessions", json={}).status_code, 404)
        self.assertEqual(self.participant.get("/protocol/sa_bank_v2.json").status_code, 404)
        self.assertEqual(self.admin.post("/api/collection/admin/login", json={
            "username": "admin", "password": "1111"
        }, headers={"Origin": "https://other.example"}).status_code, 403)
        self.assertEqual(self.login(self.admin).status_code, 200)
        link = self.shared_link(self.admin)
        self.assertEqual(self.enroll(link, "1" * 32, consent_confirmed=False).status_code, 400)
        self.assertEqual(self.enroll(link, "1" * 32, code="wrong").status_code, 403)
        self.assertEqual(self.admin.get("/api/collection/admin/sessions").json["sessions"], [])
        response = self.enroll(link, "1" * 32, participant="UNSOLICITED-NAME")
        self.assertEqual(response.status_code, 201)
        first = response.json
        second = self.enroll(link, "2" * 32).json
        self.assertNotEqual(first["view"]["id"], second["view"]["id"])
        self.assertNotEqual(first["view"]["config"]["condition"], second["view"]["config"]["condition"])
        repeated = self.enroll(link, "1" * 32)
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json["view"]["id"], first["view"]["id"])
        self.assertEqual(repeated.json["token"], first["token"])
        self.assertEqual(self.admin.post("/api/collection/admin/sessions", json={
            "participant": "p001", "mode": "pilot"
        }).status_code, 405)
        record = first["view"]
        token = first["token"]
        self.assertRegex(record["config"]["participant"], r"^S-[A-F0-9]{16}$")
        self.assertFalse(record["consent_required"])
        self.assertNotIn(token, self.admin.get("/api/collection/admin/sessions").text)
        self.assertNotIn("UNSOLICITED-NAME", (self.data / (record["id"] + ".json")).read_text())
        self.assertEqual(self.admin.get(f"/api/collection/admin/sessions/{record['id']}/invite").status_code, 404)
        path = "/api/study/sessions/" + record["id"]
        self.assertEqual(self.participant.get(path).status_code, 403)
        headers = {"Authorization": "Bearer " + token}
        self.assertEqual(self.participant.get("/api/study/sessions/" + second["view"]["id"],
                                              headers=headers).status_code, 403)
        self.assertEqual(self.participant.get(path + "/json", headers=headers).status_code, 404)
        self.assertEqual(self.participant.get(path, headers=headers).json["phase"], "instructions")

        viewer = self.app.test_client()
        self.assertEqual(viewer.post("/api/collection/results/login",
                                     json={"username": "viewer", "password": "2222"}).status_code, 200)
        response = viewer.get("/api/collection/results/summary")
        self.assertFalse(response.json["researcher"])
        self.assertEqual(len(response.json["groups"]), 2)
        self.assertNotIn(record["config"]["participant"], response.text)
        self.assertNotIn(record["id"], response.text)
        self.assertNotIn(token, response.text)
        self.assertTrue(all(row["completed"] == 0 and row["metrics"]["sa_primary"]["mean"] is None
                            for row in response.json["groups"]))
        self.assertEqual(viewer.get("/api/collection/admin/backup.zip").status_code, 401)
        self.assertEqual(viewer.get(f"/api/collection/admin/sessions/{record['id']}/invite").status_code, 401)
        self.assertEqual(viewer.post("/api/collection/admin/sessions",
                                     json={"participant": "P003", "mode": "pilot"}).status_code, 401)

    def test_complete_reopen_and_export(self):
        self.assertEqual(self.login(self.admin).status_code, 200)
        link = self.shared_link(self.admin)
        enrolled = self.enroll(link, "a" * 32).json
        identifier = enrolled["view"]["id"]
        token = enrolled["token"]
        headers = {"Authorization": "Bearer " + token}
        path = "/api/study/sessions/" + identifier
        clock = 10000
        sequence = 0
        current = self.participant.get(path, headers=headers).json

        def action(name, **extra):
            nonlocal current, sequence
            sequence += 1
            with patch("study_server.time.time", return_value=clock):
                response = self.participant.post(path + "/action", headers=headers, json={
                    "action": name, "request_id": f"req-{sequence:08d}", "trial_id": current.get("trial_id"), **extra
                })
            self.assertEqual(response.status_code, 200, response.text)
            current = response.json

        action("start")
        for trial in study.load(identifier)["deck"]:
            clock += 26
            with patch("study_server.time.time", return_value=clock):
                current = self.participant.get(path, headers=headers).json
            if trial["purpose"] == "sa":
                self.assertNotIn("correct", current["question"])
                for i, question in enumerate(trial["questions"]):
                    action("answer", question_index=i, answer=question["correct"])
            else:
                action("judge", judgment="keep" if trial["valid"] else "change")
                action("confirm", order=trial["feasible_orders"][0])
            action("next")
            if current["phase"] == "break":
                action("continue")
        action("survey", tlx=dict.fromkeys(("mental", "physical", "temporal", "performance", "effort", "frustration"), 50),
               notes="UNSOLICITED-NAME")
        self.assertEqual(current["phase"], "finished")
        self.assertNotIn("summary", current)

        reopened = self.create_app(data_dir=self.data)
        with reopened.test_client() as client:
            self.assertEqual(client.get(path, headers=headers).json["phase"], "finished")
            self.assertEqual(self.login(client).status_code, 200)
            self.assertEqual(self.shared_link(client), link)
            self.assertEqual(self.enroll(link, "a" * 32).json["view"]["phase"], "finished")
            self.assertEqual(client.get("/api/collection/admin/sessions").json["sessions"][0]["completed_main"], 36)
            team = client.get("/api/collection/results/summary").json
            self.assertTrue(team["researcher"])
            self.assertEqual(team["groups"][0]["completed"], 1)
            self.assertEqual(team["groups"][0]["metrics"]["sa_primary"], {"mean": 1, "n": 1})
            self.assertEqual(team["groups"][0]["metrics"]["raw_tlx"], {"mean": 50, "n": 1})
            backup = client.get("/api/collection/admin/backup.zip")
            with ZipFile(io.BytesIO(backup.data)) as archive:
                record = json.loads(archive.read(identifier + "/session.json"))
                self.assertEqual(len(record["records"]), 40)
                self.assertEqual(record["survey"]["raw_tlx"], 50)
                self.assertEqual(record["survey"]["notes"], "")
                self.assertTrue(record["collection"]["acknowledged_utc"])
                self.assertNotIn("enrollment_hash", record["collection"])
                self.assertNotIn("token", record)
                self.assertIn(b"sa_primary", archive.read(identifier + "/summary.csv"))

    def test_existing_individual_link_can_still_resume(self):
        record = study.create_session({"participant": "LEGACY", "mode": "pilot"}, collection=True)
        path = f"/api/study/sessions/{record['id']}"
        headers = {"Authorization": "Bearer " + record["token"]}
        self.assertTrue(self.participant.get(path, headers=headers).json["consent_required"])
        start = {"action": "start", "request_id": "start-legacy"}
        self.assertEqual(self.participant.post(path + "/action", headers=headers, json=start).status_code, 400)
        self.assertEqual(self.participant.post(path + "/action", headers=headers,
                         json={**start, "consent_confirmed": True}).status_code, 200)

    def test_public_demo_json_import_is_admin_only_and_separate(self):
        route = "/api/collection/admin/demo-results"
        identifier = "a" * 32
        result = {"version": "ie416-public-demo-v1", "mode": "public-demo",
                  "condition": "node", "language": "ko",
                  "summary": {"condition": "node", "completed_main": 6, "sa_primary": 0.5,
                              "balanced_accuracy": 0.5, "final_accuracy": 2 / 3, "raw_tlx": 425 / 6},
                  "trials": [{"trial_id": f"T{i:02d}"} for i in range(1, 7)],
                  "survey": {"tlx": dict.fromkeys(("mental", "physical", "temporal", "performance",
                                                  "effort", "frustration"), 50), "notes": ""}}
        payload = {"import_id": identifier, "result": result}
        self.assertEqual(self.participant.post(route, json=payload).status_code, 401)
        viewer = self.app.test_client()
        self.assertEqual(viewer.post("/api/collection/results/login", json={
            "username": "viewer", "password": "2222"
        }).status_code, 200)
        self.assertEqual(viewer.get(route).status_code, 401)
        self.assertEqual(self.login(self.admin).status_code, 200)
        self.assertEqual(self.admin.post(route, json={**payload, "result": {"config": {"mode": "pilot"}}}).status_code, 400)
        self.assertEqual(self.admin.post(route, json=payload).status_code, 201)
        self.assertEqual(self.admin.post(route, json=payload).status_code, 200)
        self.assertEqual(self.admin.post(route, json={**payload, "result": {**result, "language": "en"}}).status_code, 409)
        self.assertEqual(self.admin.get("/api/collection/admin/sessions").json["sessions"], [])
        self.assertEqual(viewer.get("/api/collection/results/summary").json["groups"], [])
        self.assertTrue((self.data / "demo-imports" / f"{identifier}.json").is_file())

        reopened = self.create_app(data_dir=self.data).test_client()
        self.assertEqual(self.login(reopened).status_code, 200)
        rows = reopened.get(route).json["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sa_primary"], 0.5)
        exported = reopened.get(f"{route}/{identifier}/json")
        self.assertEqual(json.loads(exported.data), result)
        with ZipFile(io.BytesIO(reopened.get("/api/collection/admin/backup.zip").data)) as archive:
            self.assertEqual(archive.namelist(), [])

    def test_public_configuration(self):
        url = "https://study.example"
        with self.assertRaises(ValueError):
            self.create_app(public_url=url, data_dir=self.data, password="1111")
        app = self.create_app(public_url=url, data_dir=self.data, password="local-test-random-password")
        response = app.test_client().post("/api/collection/admin/login", base_url=url,
            headers={"Origin": url}, json={"username": "admin", "password": "local-test-random-password"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("Secure", response.headers["Set-Cookie"])
        with self.assertRaises(ValueError):
            self.create_app(public_url=url, data_dir=self.data, password="local-test-random-password",
                            viewer_password="2222")
        with self.assertRaises(ValueError):
            self.create_app(public_url=url, data_dir=self.data, password="local-test-random-password",
                            viewer_password="local-test-random-password")
        self.assertEqual(app.test_client().post("/api/collection/results/login", base_url=url,
                         json={"username": "viewer", "password": "2222"}).status_code, 403)
