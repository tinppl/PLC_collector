"""Independent, reproducible export shape check against the IDTA JSON schema.

pip install -r requirements-dev.txt
python tools/validate_aas_schema.py [--schema /path/to/aas.json]
The default download is pinned to a Git blob. No runtime dependency is added.
This does NOT validate IDTA submodel templates or all semantic constraints.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import aas_service as aas
from jsonschema import Draft201909Validator

BLOB = "4aaed6e9e2f00a21e6e50390fc19335250b6f7c2"
SOURCE = "https://api.github.com/repos/admin-shell-io/aas-specs-metamodel/git/blobs/" + BLOB


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", type=pathlib.Path)
    args = parser.parse_args()
    if args.schema:
        data = args.schema.read_bytes()
    else:
        request = Request(SOURCE, headers={"User-Agent": "PLC-Collector-schema-check", "Accept": "application/vnd.github+json"})
        try:
            with urlopen(request, timeout=30) as response:
                data = base64.b64decode(json.load(response)["content"])
        except URLError as e:
            raise SystemExit("Could not fetch pinned schema. Use --schema with the original JSON blob on offline/corporate networks: " + str(e)) from e
    actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if actual != BLOB:
        raise SystemExit("Schema Git blob digest mismatch; review and update the pinned version deliberately.")
    schema = json.loads(data)
    Draft201909Validator.check_schema(schema)
    validator = Draft201909Validator(schema)
    p = aas.initial_project()
    p["asset"].update(name="테스트 설비", manufacturer="Demo", model="Demo", serial="DEMO-001")
    validator.validate(aas.environment(p))
    p["connection"].update(protocol="modbus_tcp", host="127.0.0.1", ethernet="yes")
    p["tags"] = [{"name": "FlowRate", "address": "40001", "type": "f32", "unit": "L/min", "semantic_id": "urn:example:flow"}]
    validator.validate(aas.environment(p))
    p["connection"]["protocol"] = "xgt"
    p["tags"][0]["address"] = "%DW100"
    validator.validate(aas.environment(p))
    print("PASS: partial, Modbus TCP and XGT exports match " + schema["title"])
    print("Schema blob: " + BLOB)


if __name__ == "__main__":
    main()
