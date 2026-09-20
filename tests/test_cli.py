import json
import os
import subprocess
import sys
from pathlib import Path

from jev_trading.contracts import utcnow

ROOT = Path(__file__).resolve().parents[1]


def invoke(*args):
    env = dict(os.environ)
    env.pop("TYPESAFE_API_KEY", None)
    env.pop("TYPESAFE_AI_API_KEY", None)
    return subprocess.run([sys.executable, "-m", "jev_trading.cli", *map(str, args)],
                          env=env, text=True, capture_output=True, timeout=10)


def test_cli_decide_then_show(tmp_path, context, config, response):
    context.captured_at = utcnow()
    context_file, config_file, response_file = [tmp_path / name for name in ("ctx.json", "cfg.json", "resp.json")]
    context_file.write_text(context.model_dump_json())
    config_file.write_text(config.model_dump_json())
    response_file.write_text(json.dumps(response))
    db = tmp_path / "signals.db"
    result = invoke("decide", "--context", context_file, "--config", config_file,
                    "--recorded-response", response_file, "--db", db)
    assert result.returncode == 0, result.stderr
    signal = json.loads(result.stdout)
    assert signal["model_source"] == "recorded" and signal["final_action"] == "buy"
    shown = invoke("show", signal["decision_id"], "--db", db)
    assert shown.returncode == 0, shown.stderr
    evidence = json.loads(shown.stdout)
    assert evidence["raw_response"] == response
    assert evidence["context"]["symbol"] == context.symbol


def test_missing_key_fails_before_collecting(tmp_path):
    result = invoke("decide", "--symbol", "600519", "--config", ROOT / "examples/decision-config.json",
                    "--aistock-path", tmp_path / "nonexistent")
    assert result.returncode == 1
    assert "TYPESAFE_API_KEY" in result.stderr
    assert not result.stdout


def test_collector_keeps_venv_interpreter_symlink(tmp_path, context, monkeypatch):
    from jev_trading.collector import collect
    root = tmp_path / "upstream"
    (root / "src/core").mkdir(parents=True)
    (root / "src/core/pipeline.py").touch()
    executable = tmp_path / "base-python"
    executable.touch()
    link = tmp_path / "venv-python"
    link.symlink_to(executable)
    class Process:
        returncode = 0

        def __init__(self, args, **kwargs):
            assert args[0] == str(link)  # resolving symlink bypasses venv site-packages
            Path(args[args.index("--output") + 1]).write_text(context.model_dump_json())

        def wait(self, timeout):
            return 0
    monkeypatch.setattr("jev_trading.collector.subprocess.Popen", Process)
    result = collect(context.symbol, root, link, tmp_path / "data")
    assert result == context
