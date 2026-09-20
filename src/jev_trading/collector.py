import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from .collection_options import validate_options
from .contracts import ContextSnapshot


def collect(symbol: str, root: Path, python: Path, data_dir: Path, timeout: float = 300, options: dict | None = None) -> ContextSnapshot:
    if not symbol.strip() or not 0 < timeout <= 1800:
        raise ValueError("symbol is required; collection timeout must be between 0 and 1800 seconds")
    options = validate_options({} if options is None else options)
    # Do not resolve the venv Python symlink: its invocation path selects site-packages.
    root, python, data_dir = root.resolve(), python.absolute(), data_dir.resolve()
    if not (root / "src/core/pipeline.py").is_file() or not python.is_file():
        raise ValueError("Set AISTOCK_PATH and AISTOCK_PYTHON to an AIStock checkout and its Python environment")
    data_dir.mkdir(parents=True, exist_ok=True)
    worker = Path(__file__).with_name("aistock_worker.py")
    with tempfile.TemporaryDirectory(prefix="jev-context-") as temp:
        output = Path(temp) / "context.json"
        with (data_dir / "collection.log").open("a", encoding="utf-8") as log:
            process = subprocess.Popen(
                [str(python), str(worker), "--root", str(root), "--symbol", symbol,
                 "--output", str(output), "--database", str(data_dir / "aistock.db"), "--collection-options", json.dumps(options)],
                stdout=log, stderr=log, start_new_session=True,
            )
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise RuntimeError("Collection timed out; see data/collection.log") from None
        if process.returncode != 0 or not output.is_file():
            raise RuntimeError(f"AIStock collection failed; see {data_dir / 'collection.log'}")
        return ContextSnapshot.model_validate_json(output.read_text(encoding="utf-8"))
