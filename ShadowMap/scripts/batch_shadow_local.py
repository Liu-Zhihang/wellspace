"""
批量阴影计算（纯 Python，本地数据版）

功能：
- 从任务 CSV 读取时间戳与 bbox
- 直接读取本地建筑数据（GeoJSON/GPKG，需包含 height 字段或可推导）
- 调用 shadow-engine-prototype/engine_core 计算阴影与覆盖率
- 输出结果 CSV，记录状态与错误信息

用法示例：
python batch_shadow_local.py \
  --tasks /path/to/tasks.csv \
  --buildings /path/to/buildings/hk_buildings_clip.geojson \
  --timezone Asia/Hong_Kong \
  --output /tmp/shadow_results.csv \
  --workers 4

任务 CSV 字段（最少需要以下列，大小写忽略）：
- timestamp (ISO8601，可带 Z)
- west, south, east, north (数值 bbox)
可选：
- id / task_id （会原样写回输出，便于对照）
"""

from __future__ import annotations

import argparse
import csv
import multiprocessing as mp
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import geopandas as gpd
import pandas as pd

# 将 shadow-engine-prototype 加入路径
ROOT = Path(__file__).resolve().parent
ENGINE_PATH = ROOT / "shadow-engine-prototype"
if str(ENGINE_PATH) not in sys.path:
  sys.path.append(str(ENGINE_PATH))

try:
  from engine_core import generate_shadows, calculate_shadow_coverage
except ImportError as exc:  # pragma: no cover - 运行时检查
  raise SystemExit(f"[Fatal] 无法导入 engine_core，请确认路径与依赖。原始错误：{exc}") from exc


@dataclass
class Task:
  idx: int
  timestamp: str
  bounds: Dict[str, float]
  meta: Dict[str, Any]


def parse_tasks(tasks_csv: Path) -> List[Task]:
  rows = []
  with tasks_csv.open(newline="", encoding="utf-8") as fh:
    reader = csv.DictReader(fh)
    required = {"timestamp", "west", "south", "east", "north"}
    missing = required - {c.lower() for c in reader.fieldnames or []}
    if missing:
      raise ValueError(f"任务文件缺少必需列: {', '.join(missing)}")

    for idx, row in enumerate(reader):
      def get_num(key: str) -> float:
        return float(row[key])

      bounds = {
        "west": get_num("west"),
        "south": get_num("south"),
        "east": get_num("east"),
        "north": get_num("north"),
      }
      meta = {k: v for k, v in row.items() if k not in ("timestamp", "west", "south", "east", "north")}
      rows.append(Task(idx=idx, timestamp=row["timestamp"], bounds=bounds, meta=meta))
  return rows


def load_buildings(buildings_path: Path, bounds: Dict[str, float]) -> gpd.GeoDataFrame:
  bbox = (bounds["west"], bounds["south"], bounds["east"], bounds["north"])
  gdf = gpd.read_file(buildings_path, bbox=bbox)
  return gdf


def process_one(task: Task, buildings_path: Path, timezone: str) -> Dict[str, Any]:
  result: Dict[str, Any] = {
    "task_idx": task.idx,
    "timestamp": task.timestamp,
    "west": task.bounds["west"],
    "south": task.bounds["south"],
    "east": task.bounds["east"],
    "north": task.bounds["north"],
    **task.meta,
  }
  try:
    buildings = load_buildings(buildings_path, task.bounds)
    result["building_count"] = len(buildings)
    if buildings.empty:
      result["status"] = "no_buildings"
      return result

    shadows = generate_shadows(buildings, task.timestamp, timezone)
    coverage = calculate_shadow_coverage(task.bounds, shadows)

    result.update({
      "status": "ok",
      "bbox_area_sqm": coverage.get("bbox_area_sqm"),
      "shadow_area_sqm": coverage.get("shadow_area_sqm"),
      "coverage_percent": coverage.get("coverage_percent"),
      "shadows_count": len(shadows),
    })
  except Exception as exc:  # pragma: no cover - 运行时捕获
    result["status"] = "error"
    result["error"] = str(exc)
  return result


def run_parallel(tasks: List[Task], buildings_path: Path, timezone: str, workers: int) -> List[Dict[str, Any]]:
  args = [(t, buildings_path, timezone) for t in tasks]
  with mp.Pool(processes=workers) as pool:
    results = pool.starmap(process_one, args)
  return results


def main() -> None:
  parser = argparse.ArgumentParser(description="本地批量阴影计算（纯 Python）")
  parser.add_argument("--tasks", required=True, type=Path, help="任务 CSV，含 timestamp, west, south, east, north 列")
  parser.add_argument("--buildings", required=True, type=Path, help="本地建筑数据 (GeoJSON/GPKG)，需含 height 字段")
  parser.add_argument("--timezone", default="Asia/Hong_Kong", help="时区，默认 Asia/Hong_Kong")
  parser.add_argument("--output", required=True, type=Path, help="输出 CSV 路径")
  parser.add_argument("--workers", type=int, default=4, help="并行进程数")

  args = parser.parse_args()

  tasks = parse_tasks(args.tasks)
  if not tasks:
    raise SystemExit("任务为空，退出。")

  workers = max(1, args.workers)
  print(f"[Info] 任务数={len(tasks)}, 并行={workers}")
  results = run_parallel(tasks, args.buildings, args.timezone, workers)

  df = pd.DataFrame(results)
  df.to_csv(args.output, index=False)
  print(f"[Done] 已写出结果: {args.output} (共 {len(df)} 条)")


if __name__ == "__main__":
  main()
