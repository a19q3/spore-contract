"""Run the CCC Type ID acceptance matrix against a fresh loopback-only CKB dev chain."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MATRIX = Path(__file__).with_name("matrix.mjs")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def source_revision(repo):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()

    return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ccc", type=Path, required=True, help="built CCC source checkout")
    parser.add_argument("--ckb", type=Path, required=True, help="Meepo-capable CKB binary")
    args = parser.parse_args()
    target = ROOT / "tests/target"
    target.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="ccc-type-id-", dir=target))
    print("Acceptance directory", run, flush=True)
    binary = args.ckb.resolve()
    node = run / "node"
    node.mkdir()
    port = free_port()
    p2p = free_port()
    while port == p2p:
        p2p = free_port()
    url = f"http://127.0.0.1:{port}"
    env = {**os.environ, "CCC_ROOT": str(args.ccc.resolve()), "SPORE_RUN": str(run),
           "SPORE_RPC": url, "SPORE_ROOT": str(ROOT),
           "SPORE_NODE_VERSION": subprocess.check_output([binary, "--version"], text=True).strip()}
    lock_args = subprocess.check_output(["node", MATRIX, "owner"], env=env, text=True).strip()
    subprocess.run([binary, "init", "-C", node, "-c", "dev", "--rpc-port", str(port),
                    "--p2p-port", str(p2p), "--ba-arg", lock_args], check=True)
    config = node / "ckb.toml"
    lines = config.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("modules ="):
            lines[i] = 'modules = ["Chain", "Pool", "Miner", "Stats", "Experiment", "IntegrationTest", "Indexer"]'
        if line.startswith("listen_addresses ="):
            lines[i] = f'listen_addresses = ["/ip4/127.0.0.1/tcp/{p2p}"]'
    config.write_text("\n".join(lines) + "\n")
    spec = node / "specs/dev.toml"
    with spec.open("a") as file:
        file.write(f'\n[[genesis.issued_cells]]\ncapacity = 10_000_000_00000000\n'
                   f'lock.code_hash = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"\n'
                   f'lock.hash_type = "type"\nlock.args = "{lock_args}"\n')
    revisions = {"contracts": source_revision(ROOT), "ccc": source_revision(args.ccc.resolve())}
    with (run / "node.log").open("w") as log:
        child = subprocess.Popen([binary, "run", "-C", node, "--indexer"], stdout=log, stderr=log)
        try:
            request = urllib.request.Request(url, data=b'{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}', headers={"Content-Type":"application/json"})
            for _ in range(150):
                if child.poll() is not None:
                    raise RuntimeError(f"CKB stopped, see {run / 'node.log'}")
                try:
                    with urllib.request.urlopen(request, timeout=1) as response:
                        if json.load(response).get("result"):
                            break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError("CKB did not become ready")
            subprocess.run(["node", MATRIX], cwd=ROOT, env=env, check=True)
            env["SPORE_V3_VM_CAPTURE"] = str(run / "transactions.jsonl")
            subprocess.run(["cargo","test","--locked","--manifest-path","tests/Cargo.toml",
                            "sdk_captured_transactions_replay_in_ckb_vm","--","--ignored","--nocapture"],
                           cwd=ROOT, env=env, check=True)
            report_path = run / "results.json"
            report = json.loads(report_path.read_text())
            with (run / "transactions.jsonl").open("rb") as captures:
                digest = hashlib.file_digest(captures, "sha256").hexdigest()
            report["sources"] = revisions
            report["replay"] = {"cases": len(report["cases"]), "sha256": digest}
            report_path.write_text(json.dumps(report, indent=2) + "\n")
        finally:
            child.terminate()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
