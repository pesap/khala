#!/usr/bin/env python3
"""Score Agent Skills alignment for a skills directory."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


WEIGHTS = {
    "spec": 0.25,
    "progressive": 0.20,
    "trigger": 0.20,
    "scope": 0.15,
    "resources": 0.10,
    "evals": 0.10,
}


@dataclass
class SkillScore:
    name: str
    total: float
    categories: dict[str, float]
    gaps: list[str]


def frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = re.match(r"^---\n([\s\S]*?)\n---\n?", text)
    if not match:
        return {}, text
    meta: dict[str, str] = {}
    lines = match.group(1).splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if ":" not in line or line.startswith((" ", "\t")):
            index += 1
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value in {">", "|"}:
            block: list[str] = []
            index += 1
            while index < len(lines) and lines[index].startswith((" ", "\t")):
                block.append(lines[index].strip())
                index += 1
            meta[key] = " ".join(block)
            continue
        meta[key] = value.strip('"')
        index += 1
    return meta, text[match.end() :]


def has_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def score_skill(path: Path) -> SkillScore:
    text = path.read_text(encoding="utf-8")
    meta, body = frontmatter(text)
    skill_dir = path.parent
    name = skill_dir.name
    desc = meta.get("description", "")
    extra = [key for key in meta if key not in {"name", "description"}]
    body_lines = body.count("\n") + 1
    desc_has_trigger = has_any(desc, [r"\buse when\b", r"\bwhen users?\b", r"\bask"])
    has_avoid = has_any(body, [r"## Avoid", r"\bAvoid when\b", r"\bDo not use\b"])
    has_workflow = has_any(body, [r"## Workflow", r"## Steps", r"## Instructions", r"## Rules"])
    has_output = has_any(body, [r"## Output", r"## Validation", r"## Result"])
    has_refs = (skill_dir / "references").exists() or any(
        p.name != "SKILL.md" and p.suffix.lower() == ".md" for p in skill_dir.iterdir()
    )
    has_scripts = (skill_dir / "scripts").exists() or (skill_dir / "tools").exists()
    has_evals = (skill_dir / "evals").exists()

    categories: dict[str, float] = {}
    categories["spec"] = 10.0
    if meta.get("name") != name:
        categories["spec"] -= 5
    if not desc:
        categories["spec"] -= 4
    if extra:
        categories["spec"] -= min(2, len(extra))
    categories["spec"] = max(categories["spec"], 0)

    categories["progressive"] = 10.0
    if body_lines > 120:
        categories["progressive"] -= 2
    if body_lines > 220:
        categories["progressive"] -= 3
    if body_lines > 80 and not has_refs:
        categories["progressive"] -= 2
    categories["progressive"] = max(categories["progressive"], 0)

    categories["trigger"] = 4.0
    if 120 <= len(desc) <= 700:
        categories["trigger"] += 3
    if desc_has_trigger:
        categories["trigger"] += 2
    if has_any(desc, [r"\beven if\b", r"\bwithout\b", r"\bimplicit", r"\bnear"]):
        categories["trigger"] += 1
    categories["trigger"] = min(categories["trigger"], 10)

    categories["scope"] = 3.0
    if has_any(body, [r"## Use when", r"## Trigger"]):
        categories["scope"] += 2
    if has_avoid:
        categories["scope"] += 3
    if has_workflow:
        categories["scope"] += 1
    if has_output:
        categories["scope"] += 1
    categories["scope"] = min(categories["scope"], 10)

    categories["resources"] = 6.0
    if has_refs:
        categories["resources"] += 2
    if has_scripts:
        categories["resources"] += 1
    if has_any(body, [r"references/", r"scripts/", r"\.md\)", r"`[^`]+\.sh`"]):
        categories["resources"] += 1
    categories["resources"] = min(categories["resources"], 10)

    categories["evals"] = 10.0 if has_evals else 3.0

    total = sum(categories[key] * weight for key, weight in WEIGHTS.items())
    gaps: list[str] = []
    if categories["spec"] < 9:
        gaps.append("frontmatter")
    if categories["trigger"] < 8:
        gaps.append("trigger")
    if categories["scope"] < 8:
        gaps.append("boundaries")
    if categories["progressive"] < 8:
        gaps.append("progressive-disclosure")
    if categories["evals"] < 8:
        gaps.append("evals")
    return SkillScore(name=name, total=total, categories=categories, gaps=gaps)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("skills_dir", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    scores = [
        score_skill(path)
        for path in sorted(args.skills_dir.glob("*/SKILL.md"))
    ]
    scores.sort(key=lambda item: (item.total, item.name))

    if args.json:
        print(
            json.dumps(
                [
                    {
                        "name": item.name,
                        "total": round(item.total, 2),
                        "categories": {
                            key: round(value, 2)
                            for key, value in item.categories.items()
                        },
                        "gaps": item.gaps,
                    }
                    for item in scores
                ],
                indent=2,
            )
        )
        return 0

    print("score  skill                     gaps")
    print("-----  ------------------------  -----------------------------")
    for item in scores:
        print(f"{item.total:5.2f}  {item.name:24}  {', '.join(item.gaps) or '-'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
