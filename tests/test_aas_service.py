"""Behavior and hostile-input regression tests; standard library only."""
import base64
import copy
import io
import http.client
import json
import os
import tempfile
import threading
import unittest
import zipfile
from unittest.mock import patch

import aas_service as aas
import server


def project():
    p = aas.initial_project()
    p["asset"].update(name="냉각수 유량계", manufacturer="Demo", model="FC-5000", serial="TEST-001")
    p["connection"].update(protocol="modbus_tcp", host="127.0.0.1", port=5023, ethernet="yes", signal="plc")
    p["tags"] = [{"name": "FlowRate", "address": "40001", "type": "f32", "unit": "L/min",
                  "area": "holding", "word_order": "big", "factor": 1, "offset": 0, "semantic_id": ""}]
    return p


def upload(data, name="asset.aasx"):
    return aas.inspect_upload(name, base64.b64encode(data).decode())


def repack(data, edit):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = {n: z.read(n) for n in z.namelist()}
    edit(files)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, content in files.items():
            z.writestr(n, content)
    return buf.getvalue()


class AasTests(unittest.TestCase):
    def test_roundtrip_preserves_identity_connection_scaling_and_semantics(self):
        p = project()
        p["tags"][0].update(factor=0.1, offset=-2, semantic_id="urn:example:flow")
        result = upload(aas.package(p))
        self.assertEqual(result["project"], p)
        self.assertTrue(result["report"]["can_apply"])
        self.assertEqual(len(result["submodels"]), 3)

    def test_submodel_identifiers_stay_stable_after_rename(self):
        p = project()
        before = [s["id"] for s in aas.environment(p)["submodels"]]
        p["asset"]["name"] = "Renamed"
        self.assertEqual(before, [s["id"] for s in aas.environment(p)["submodels"]])

    def test_partial_asset_can_export_but_cannot_apply(self):
        p = project()
        p["connection"].update(protocol="unknown", ethernet="unknown", host="")
        p["tags"] = []
        r = aas.assess(p)
        self.assertTrue(r["can_export"])
        self.assertFalse(r["can_apply"])
        self.assertEqual(upload(aas.package(p))["project"], p)

    def test_missing_identity_blocks_export(self):
        with self.assertRaises(aas.AasError):
            aas.package(aas.initial_project())

    def test_recommendations_do_not_claim_cpu_compatibility(self):
        p = project()
        p["connection"].update(signal="4-20ma", channels=17)
        rec = aas.assess(p)["recommendations"][0]
        self.assertEqual(rec["quantity"], 3)
        self.assertEqual(rec["status"], "조건부 후보")
        p["connection"].update(signal="rtd")
        self.assertNotEqual(aas.assess(p)["recommendations"][0]["product"], "Advantech ADAM-6017")

    def test_unknown_cpu_does_not_recommend_specific_module(self):
        p = project()
        p["connection"].update(ethernet="no")
        rec = aas.assess(p)["recommendations"][0]
        self.assertNotIn("XGL-", rec["product"])
        self.assertFalse(aas.assess(p)["can_apply"])

    def test_bad_mapping_and_duplicate_names_block_apply(self):
        for change in ({"address": "-1"}, {"address": "65535", "type": "f32"}, {"type": "unknown"},
                       {"name": "공백 포함"}, {"word_order": "other"}):
            with self.subTest(change=change):
                p = project()
                p["tags"][0].update(change)
                self.assertFalse(aas.assess(p)["can_apply"])
        p = project()
        p["tags"].append(copy.deepcopy(p["tags"][0]))
        self.assertFalse(aas.assess(p)["can_apply"])

    def test_xgt_mapping(self):
        p = project()
        p["connection"].update(protocol="xgt", port=2004)
        p["tags"][0].update(address="%DW100", word_order="little")
        self.assertTrue(aas.assess(p)["can_apply"])
        self.assertEqual(aas.config_plan(p, {})["additions"]["devices"].popitem()[1]["driver"], "xgt")
        p["tags"][0]["address"] = "%ZW100"
        self.assertFalse(aas.assess(p)["can_apply"])

    def test_nonfinite_and_wrong_types_are_rejected(self):
        for path, value in (("factor", float("nan")), ("offset", float("inf")), ("factor", True)):
            p = project()
            p["tags"][0][path] = value
            with self.assertRaises(aas.AasError):
                aas.normalize(p)
        for value in (None, [], "x", True):
            with self.assertRaises(aas.AasError):
                aas.normalize(value)

    def test_invalid_unicode_is_rejected_as_user_error(self):
        p = project()
        p["asset"]["name"] = "\ud800"
        with self.assertRaises(aas.AasError):
            aas.normalize(p)
        env = aas.environment(project())
        env["assetAdministrationShells"][0]["idShort"] = "\ud800"
        with self.assertRaises(aas.AasError):
            upload(json.dumps(env).encode(), "bad.json")

    def test_incompatible_profile_version_rejected(self):
        p = project()
        p["schema_version"] = 2
        with self.assertRaises(aas.AasError):
            aas.normalize(p)

    def test_generic_environment_inspected_without_fabricated_mapping(self):
        env = aas.environment(project())
        env["submodels"] = env["submodels"][:1]
        result = upload(json.dumps(env).encode(), "external.json")
        self.assertIsNone(result["project"])
        self.assertIn("asset_id", result["shells"][0])

    def test_import_does_not_access_network(self):
        with patch("socket.socket", side_effect=AssertionError("must not connect")):
            self.assertIsNotNone(upload(aas.package(project()))["project"])

    def test_relationship_resolution_not_filename_guessing(self):
        data = aas.package(project())
        def move(files):
            files["models/renamed.json"] = files.pop("aasx/data.json")
            files["aasx/_rels/aasx-origin.rels"] = files["aasx/_rels/aasx-origin.rels"].replace(b"/aasx/data.json", b"../models/renamed.json")
        self.assertIsNotNone(upload(repack(data, move))["project"])

    def test_malformed_zip_json_base64_and_xml(self):
        for data, name in ((b"not zip", "bad.aasx"), (b"{", "bad.json"), (b'{"x":NaN}', "bad.json"),
                           (b'{"x":1,"x":2}', "bad.json")):
            with self.subTest(name=name, data=data), self.assertRaises(aas.AasError):
                upload(data, name)
        with self.assertRaises(aas.AasError):
            aas.inspect_upload("asset.aasx", "!!!!")
        for data in (b'<!DOCTYPE x [<!ENTITY a "xx">]><x/>', '<x/>'.encode('utf-16')):
            with self.assertRaises(aas.AasError):
                aas._xml(data)

    def test_unsafe_archive_paths_rejected(self):
        for name in ("../evil", "\\evil", "/evil"):
            with self.subTest(name=name), self.assertRaises(aas.AasError):
                upload(repack(aas.package(project()), lambda files: files.update({name: b"x"})))

    def test_duplicate_entries_rejected(self):
        buf = io.BytesIO(aas.package(project()))
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(buf, "a") as z:
                z.writestr("aasx/data.json", "{}")
        with self.assertRaises(aas.AasError):
            upload(buf.getvalue())

    def test_expansion_and_upload_limits(self):
        with patch.object(aas, "MAX_EXPANDED", 10), self.assertRaises(aas.AasError):
            upload(aas.package(project()))
        with patch.object(aas, "MAX_UPLOAD", 10), self.assertRaises(aas.AasError):
            upload(aas.package(project()))

    def test_external_relationship_and_xml_only_package_rejected(self):
        for old, new in ((b"/aasx/data.json", b"https://example.com/data.json"),
                         (b"/aasx/data.json", b"/aasx/data.xml")):
            def edit(files):
                key = "aasx/_rels/aasx-origin.rels"
                files[key] = files[key].replace(old, new)
            with self.assertRaises(aas.AasError):
                upload(repack(aas.package(project()), edit))

    def test_profile_identity_mismatch_rejected(self):
        env = aas.environment(project())
        env["assetAdministrationShells"][0]["id"] = "urn:wrong"
        with self.assertRaises(aas.AasError):
            upload(json.dumps(env).encode(), "tampered.json")

    def test_missing_profile_reference_rejected(self):
        env = aas.environment(project())
        env["assetAdministrationShells"][0]["submodels"] = []
        with self.assertRaises(aas.AasError):
            upload(json.dumps(env).encode(), "tampered.json")

    def test_malformed_environment_returns_user_error(self):
        for key, value in (("assetInformation", []), ("submodels", None), ("modelType", {})):
            env = aas.environment(project())
            env["assetAdministrationShells"][0][key] = value
            with self.assertRaises(aas.AasError):
                upload(json.dumps(env).encode(), "bad.json")

    def test_plans_preserve_existing_and_report_conflicts(self):
        existing = {"devices": {"old": {"host": "127.0.0.1"}}, "tags": {}, "jobs": {}}
        before = copy.deepcopy(existing)
        p = project()
        plan = aas.config_plan(p, existing)
        self.assertEqual(existing, before)
        self.assertTrue(plan["can_apply"])
        for k, values in plan["additions"].items():
            existing[k].update(values)
        self.assertFalse(aas.config_plan(p, existing)["can_apply"])

    def test_draft_revision_and_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            store = aas.ProjectStore(temp)
            self.assertIsNone(store.load()["revision"])
            doc = store.save(project(), None)
            self.assertEqual(aas.ProjectStore(temp).load(), doc)
            with self.assertRaises(aas.AasError):
                store.save(project(), None)
            self.assertNotEqual(store.save(doc["project"], doc["revision"])["revision"], doc["revision"])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = server.State()
        self.state.raw = {"devices": {}, "tags": {}, "jobs": {}}
        self.state.cfg = server.build_config(self.state.raw)
        for key, value in (("ST", self.state), ("DATA", self.temp.name),
                           ("CONFIG", os.path.join(self.temp.name, "config.json")),
                           ("BACKUP", os.path.join(self.temp.name, "backups"))):
            patcher = patch.object(server, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        os.makedirs(server.BACKUP)
        with open(server.CONFIG, "w", encoding="utf-8") as f:
            json.dump(self.state.raw, f)

    def call(self, name, body):
        return server.api("POST", "/api/aas/" + name, {}, body)

    def test_apply_requires_unchanged_config_and_creates_backup(self):
        p = project()
        plan = self.call("plan", {"project": p})
        self.state.raw["devices"]["other"] = {"host": "127.0.0.1"}
        with self.assertRaises(server.ApiError):
            self.call("apply", {"project": p, "config_revision": plan["config_revision"]})
        plan = self.call("plan", {"project": p})
        self.call("apply", {"project": p, "config_revision": plan["config_revision"]})
        self.assertIn("other", self.state.raw["devices"])
        self.assertEqual(len(self.state.raw["devices"]), 2)
        self.assertTrue(os.listdir(server.BACKUP))
        with self.assertRaises(server.ApiError):
            self.call("apply", {"project": p, "config_revision": plan["config_revision"]})

    def test_running_collection_blocks_apply(self):
        p = project()
        plan = self.call("plan", {"project": p})
        class Running:
            running = True
        self.state.runner = Running()
        with self.assertRaises(server.ApiError):
            self.call("apply", {"project": p, "config_revision": plan["config_revision"]})
        self.assertEqual(self.state.raw["devices"], {})

    def test_bad_request_is_api_error(self):
        for name in ("assess", "plan", "import"):
            with self.assertRaises(server.ApiError):
                self.call(name, {"project": None})

    def test_http_roundtrip_and_request_guards(self):
        with patch.object(server, "PASSWORD", None, create=True):
            httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            httpd.daemon_threads = True
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            try:
                def request(method, path, body=None, guard=True):
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    headers = {"Content-Type": "application/json"}
                    if guard:
                        headers["X-Requested-With"] = "plc-collector"
                    data = json.dumps(body) if body is not None else None
                    connection.request(method, path, data, headers)
                    response = connection.getresponse()
                    payload = response.read()
                    result = response.status, response.getheader("Content-Type"), payload
                    connection.close()
                    return result
                self.assertEqual(request("GET", "/")[0], 200)
                p = project()
                status, _, data = request("PUT", "/api/aas/project", {"project": p, "revision": None})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(data)["project"], p)
                status, mime, package = request("POST", "/api/aas/export", {"project": p})
                self.assertEqual(status, 200)
                self.assertEqual(mime, "application/aas+zip")
                status, _, data = request("POST", "/api/aas/import", {"filename": "test.aasx", "content": base64.b64encode(package).decode()})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(data)["project"], p)
                self.assertEqual(request("POST", "/api/aas/assess", {"project": p}, guard=False)[0], 403)
                self.assertEqual(request("POST", "/api/aas/import", {"filename": "bad.aasx", "content": "!"})[0], 400)
                self.assertEqual(request("POST", "/api/aas/export", {"project": None})[0], 400)
                self.assertEqual(request("POST", "/api/aas/assess", [1])[0], 400)
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
