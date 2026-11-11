"""IE416 scripted DES stimuli and server-side scoring; no trained AI model."""
from itertools import permutations
from collections import Counter
from copy import deepcopy
from pathlib import Path
import hashlib
import json
import os
import random

VERSION = "ie416-2026-11-11-v4"
POST_TASK_SURVEY = "weighted-tlx-interview-v1"
ROBOTS = ("A", "B", "C")
ORDERS = list(permutations(ROBOTS))
DEFAULT_SA_BANK = Path(__file__).resolve().parent / "protocol" / "sa_bank_v2.json"
SA_BANK = Path(os.environ.get("IE416_SA_BANK_PATH") or DEFAULT_SA_BANK).expanduser()
DEFAULT_SA_ALT_BANK = DEFAULT_SA_BANK.with_name("sa_bank_alt_v2.json")
SA_ALT_BANK = Path(os.environ.get("IE416_SA_ALT_BANK_PATH") or DEFAULT_SA_ALT_BANK).expanduser()


def sa_bank_file(condition):
    if condition == "node":
        return SA_BANK, "sa-fixed-ko-v2"
    if condition == "table":
        return SA_ALT_BANK, "sa-alternate-ko-v2"
    raise ValueError("SA 문항을 선택할 UI 조건이 필요합니다.")


def load_sa_bank(condition="node"):
    """Load the fixed, private SA form assigned to this UI."""
    path, version = sa_bank_file(condition)
    bank = json.loads(path.read_text(encoding='utf-8'))
    if bank['version'] != version or len(bank['cases']) != 12:
        raise ValueError('Unexpected fixed SA bank version or size')
    if {s['bank_id'] for s in bank['cases']} != {f'S{i:02d}' for i in range(1, 13)}:
        raise ValueError('SA bank IDs must be S01 through S12')
    return bank


def sa_bank_metadata(condition="node"):
    path, version = sa_bank_file(condition)
    return {'sa_bank_version': version,
            'sa_bank_sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def warehouse_map():
    """Purpose-built schematic aisles. No external or KAIROS map assets."""
    nodes = [{"id": f"N{x}_{y}", "x": x * 100, "y": y * 110}
             for y in range(5) for x in range(7)]
    edges = []
    for y in range(5):
        for x in range(7):
            targets = []
            if x < 6 and y in (0, 2, 4):
                targets.append((x + 1, y))
            if y < 4 and x in (0, 2, 4, 6):
                targets.append((x, y + 1))
            for xx, yy in targets:
                a, b = f"N{x}_{y}", f"N{xx}_{yy}"
                edges += [{"from": a, "to": b}, {"from": b, "to": a}]
    # Fourteen fixed request sites distributed across the schematic aisles.
    positions = [(0,0),(2,0),(4,0),(6,0),(0,2),(2,2),(4,2),(6,2),
                 (0,4),(2,4),(4,4),(6,4),(0,1),(6,3)]
    ports = [{"id": f"W{i+1:02d}", "nodeId": f"N{x}_{y}"} for i,(x,y) in enumerate(positions)]
    shelves = [{"x": x * 100 + 30, "y": y * 110 + 24, "width": 140, "height": 172}
               for y in (0,2) for x in (0,2,4)]
    payload = {"name": "실험용 가상 물류 창고", "nodes": nodes, "edges": edges,
               "ports": ports, "shelves": shelves, "source": "Synthetic IE416 schematic; no external map data"}
    payload["sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return payload


def outcomes(order, durations, deadlines):
    if tuple(sorted(order)) != ROBOTS:
        raise ValueError("Order must contain A, B, and C once")
    elapsed, result = 0, {}
    for robot in order:
        start = elapsed
        elapsed += durations[robot]
        result[robot] = {"start": start, "finish": elapsed,
                         "overrun": max(0, elapsed - deadlines[robot])}
    return result


def feasible_orders(durations, deadlines):
    return [list(order) for order in ORDERS
            if all(x["overrun"] == 0 for x in outcomes(order, durations, deadlines).values())]


def recommend(durations, deadlines, preference):
    """Deterministic feasibility scheduler with a recorded tie-breaking preference."""
    feasible = feasible_orders(durations, deadlines)
    rank = {r: i for i, r in enumerate(preference)}
    return min(feasible, key=lambda order: tuple(rank[r] for r in order)) if feasible else None


def numeric_options(answer, rng):
    values = {answer}
    for v in [answer - 3, answer + 3, answer - 1, answer + 1, answer + 5]:
        if v >= 0:
            values.add(v)
        if len(values) == 4:
            break
    options = [{"id": str(v), "text": f"{v}분"} for v in sorted(values)]
    rng.shuffle(options)
    return options


def questions_for(scenario, subtype, rng):
    """Candidate-item authoring helper; live SA trials use the fixed bank."""
    event = scenario["event"]
    current = scenario["current"]
    order = scenario["recommendation"]
    result = outcomes(order, current["durations"], current["deadlines"])
    perception_answer = event["robot"] if event["kind"] != "none" else "none"
    perception = {"level": "perception", "subtype": "perception",
                  "prompt": "처음 상태와 비교해 값이 변경된 로봇은 어느 것입니까?",
                  "options": [{"id": r, "text": f"로봇 {r}"} for r in ROBOTS] + [{"id": "none", "text": "변경 없음"}],
                  "correct": perception_answer}
    rng.shuffle(perception["options"])
    target = order[rng.choice([1, 2])]
    finish = result[target]['finish']
    deadline = current['deadlines'][target]
    # Every option interprets a concrete completion/deadline pair. A generic
    # statement about sequential processing could be answered without viewing
    # this trial at all, so it is not used as the comprehension question.
    pairs = [(finish, deadline)]
    alternatives = [(finish, scenario['initial']['deadlines'][target]),
                    (current['durations'][target], deadline),
                    (finish, deadline + 3), (finish + 3, deadline),
                    (finish, max(1, deadline - 2))]
    rng.shuffle(alternatives)
    for pair in alternatives:
        if pair not in pairs:
            pairs.append(pair)
        if len(pairs) == 4:
            break
    def interpretation(pair):
        completed, due = pair
        delta = completed - due
        meaning = f'{delta}분 초과한다' if delta > 0 else (f'{-delta}분 여유로 충족한다' if delta < 0 else '정확히 충족한다')
        return f'앞선 개입을 반영하면 완료는 {completed}분, 마감은 {due}분이므로 마감을 {meaning}.'
    comprehension = {"level": "comprehension", "subtype": "comprehension",
                     "prompt": f"현재 상태와 기존 추천을 함께 고려할 때, {target}의 마감 충족 여부에 대한 정확한 해석은 무엇입니까?",
                     "options": [{"id": f"at{pair[0]}_due{pair[1]}", "text": interpretation(pair),
                                  "finish": pair[0], "deadline": pair[1]} for pair in pairs],
                     "target": target, "correct": f"at{finish}_due{deadline}"}
    rng.shuffle(comprehension["options"])
    if subtype == "recall":
        target = rng.choice(list(ROBOTS))
        answer = result[target]["finish"]
        prompt = f"현재 추천 {' → '.join(order)}에서 {target}의 예상 완료 시각은 언제입니까?"
        alternate = None
    else:
        candidates = []
        displayed = {value for r in result.values() for value in r.values()}
        displayed.update(current["durations"].values())
        displayed.update(current["deadlines"].values())
        for alternate_order in ORDERS:
            other = outcomes(alternate_order, current["durations"], current["deadlines"])
            # Ask about the second intervention, requiring integration of two
            # durations rather than copying the first robot's own duration.
            for robot in [alternate_order[1]]:
                if other[robot]["finish"] != result[robot]["finish"]:
                    candidates.append((other[robot]["finish"] not in displayed, list(alternate_order), robot, other[robot]["finish"]))
        preferred = [x for x in candidates if x[0]] or candidates
        _, alternate, target, answer = rng.choice(preferred)
        prompt = f"개입 순서를 {' → '.join(alternate)}로 바꾸면 {target}의 완료 시각은 언제입니까?"
    outcome = {"level": "outcome", "subtype": subtype, "prompt": prompt,
               "options": numeric_options(answer, rng), "correct": str(answer),
               "alternate_order": alternate, "target": target}
    return [perception, comprehension, outcome]


def make_scenario(rng, kind, index, purpose, subtype=None, practice=False):
    # Vary robot labels/order and one changed attribute. All six schedules are
    # checked before a stimulus is admitted to the bank.
    for attempt in range(20000):
        preference = list(ROBOTS)
        rng.shuffle(preference)
        durations = {r: rng.randint(3, 8) for r in ROBOTS}
        elapsed, deadlines = 0, {}
        for r in preference:
            elapsed += durations[r]
            deadlines[r] = elapsed + rng.randint(2, 7)
        initial = {"durations": durations, "deadlines": deadlines}
        order = recommend(durations, deadlines, preference)
        updated_durations, updated_deadlines = dict(durations), dict(deadlines)
        changed_robot = rng.choice(list(ROBOTS))
        field = rng.choice(["deadline", "duration"])
        if kind == "no_change":
            event = {"kind": "none", "robot": None, "before": None, "after": None,
                     "text": "상태 재확인 · 수치 변경 없음"}
        else:
            if field == "deadline":
                before = deadlines[changed_robot]
                after = max(1, before - rng.randint(2, max(3, before - 1)))
                if before == after:
                    continue
                updated_deadlines[changed_robot] = after
                text = f"로봇 {changed_robot}의 완료 마감이 {before}분에서 {after}분으로 앞당겨졌습니다."
            else:
                before = durations[changed_robot]
                after = before + rng.randint(2, 7)
                updated_durations[changed_robot] = after
                text = f"로봇 {changed_robot}의 개입 소요시간이 {before}분에서 {after}분으로 늘었습니다."
            event = {"kind": field, "robot": changed_robot, "before": before, "after": after, "text": text}
        feasible = feasible_orders(updated_durations, updated_deadlines)
        if not feasible:
            continue
        valid = order in feasible
        if valid != (kind != "invalid"):
            continue
        current = {"durations": updated_durations, "deadlines": updated_deadlines}
        if purpose == "sa" and subtype == "projection" and len(set(updated_durations.values())) == 1:
            continue
        scenario = {"id": f"{'P' if practice else 'T'}{index:02d}", "kind": kind, "purpose": purpose,
                    "subtype": subtype, "practice": practice, "initial": initial, "current": current,
                    "recommendation": order, "scheduler_preference": preference, "event": event,
                    "valid": valid, "feasible_orders": feasible,
                    "poses": {r: (index * 5 + k * 4) % 14 for k, r in enumerate(ROBOTS)}}
        scenario["questions"] = questions_for(scenario, subtype or "recall", rng) if purpose == "sa" else []
        return scenario
    raise RuntimeError("Could not generate a validated scenario")


def build_deck(seed, demo=False, *, condition="node"):
    rng = random.Random(seed)
    bank = {s['bank_id']: deepcopy(s) for s in load_sa_bank(condition)['cases']}
    if demo:
        practice = []
        main = []
        for i, (kind, bank_id) in enumerate([('invalid', 'S07'), ('valid_change', 'S04'), ('no_change', 'S12')]):
            main += [make_scenario(rng, kind, i*2+1, 'behavior'), bank[bank_id]]
    else:
        practice = [make_scenario(rng, kind, i + 1, "behavior", practice=True)
                    for i, kind in enumerate(["invalid", "valid_change", "invalid", "no_change"])]
        kinds = ['invalid']*12 + ['valid_change']*8 + ['no_change']*4
        main = list(bank.values()) + [make_scenario(rng, kind, i+1, 'behavior') for i, kind in enumerate(kinds)]
        rng.shuffle(main)
    for i, scenario in enumerate(main, 1):
        scenario['id'] = f'T{i:02d}'
    return practice + main


def bank_hash(deck):
    return hashlib.sha256(json.dumps(deck, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def translate_demo(deck):
    """Localize a fresh demo deck while keeping the stimuli and answer IDs."""
    for scenario in deck:
        event = scenario["event"]
        if event["kind"] == "none":
            event["text"] = "Status checked. All values are unchanged."
        elif event["kind"] == "deadline":
            event["text"] = (
                f"Robot {event['robot']}'s completion deadline moved earlier, "
                f"from {event['before']} to {event['after']} min."
            )
        else:
            event["text"] = (
                f"Robot {event['robot']}'s intervention duration increased "
                f"from {event['before']} to {event['after']} min."
            )
        order = scenario["recommendation"]
        for question in scenario["questions"]:
            if question["level"] == "perception":
                question["prompt"] = "Which robot's completion deadline changed?"
                for option in question["options"]:
                    option["text"] = "No change" if option["id"] == "none" else option["id"]
            elif question["level"] == "comprehension":
                question["prompt"] = "Which statement about the current AI recommendation is correct?"
                target = question["target"]
                preceding = " and ".join(order[:order.index(target)])
                for option in question["options"]:
                    finish, deadline = option["finish"], option["deadline"]
                    if "robot" in option:
                        status = "meets" if option["meets"] else "misses"
                        option["text"] = (
                            f"Robot {option['robot']} finishes at {finish} min "
                            f"and {status} its {deadline} min deadline."
                        )
                    else:
                        status = "meets" if finish <= deadline else "misses"
                        option["text"] = (
                            f"After handling {preceding}, {target} finishes at {finish} min "
                            f"and {status} its {deadline} min deadline."
                        )
            elif question.get("response_type") == "robot":
                question["prompt"] = f"Which robot misses its deadline in the recommended order {' → '.join(order)}?"
                for option in question["options"]:
                    option["text"] = "None" if option["id"] == "none" else option["id"]
            else:
                target = question["target"]
                alternative = question["alternate_order"]
                if alternative:
                    question["prompt"] = (
                        f"If the order changes to {' → '.join(alternative)}, "
                        f"when would robot {target} finish?"
                    )
                else:
                    question["prompt"] = (
                        f"In the recommended order {' → '.join(order)}, "
                        f"when is robot {target} expected to finish?"
                    )
                for option in question["options"]:
                    option["text"] = f"{option['id']} min"


def public_stimulus(scenario, updated):
    before, now = scenario["initial"], scenario["current"] if updated else scenario["initial"]
    result = outcomes(scenario["recommendation"], now["durations"], now["deadlines"])
    rows = []
    for r in ROBOTS:
        position = scenario["recommendation"].index(r)
        predecessor = scenario["recommendation"][position - 1] if position else None
        rows.append({"robot": r, "duration": now["durations"][r], "previous_duration": before["durations"][r],
                     "deadline": now["deadlines"][r], "previous_deadline": before["deadlines"][r],
                     **result[r], "predecessor": predecessor})
    return {"rows": rows, "order": scenario["recommendation"], "poses": scenario["poses"],
            "event": scenario["event"] if updated else None, "updated": updated,
            "recommendation_time": "변화 전", "state_time": "변화 후" if updated else "변화 전"}


def protocol_spec():
    return {"version": VERSION, "main_trials": 36, "practice_trials": 4,
            **sa_bank_metadata(),
            "sa_bank_versions": {condition: sa_bank_file(condition)[1] for condition in ("table", "node")},
            "allocation": {"sa": {"invalid": 6, "valid_change": 4, "no_change": 2},
                           "behavior": {"invalid": 12, "valid_change": 8, "no_change": 4}},
            "outcomes": {"recall": 6, "projection": 6},
            "recommendation": "사전 검증한 결정론적 스케줄러의 모의 AI 추천",
            "clock": "변화 시점부터 모의 분 단위의 새 검토 스냅샷. 실제 응답 초와 구분.",
            "feasibility": "한 사람이 동시에 가용한 요청 3개를 순차 처리. 완료 <= 마감. 가능한 모든 순서 정답.",
            "sa": "표 조건은 SA 2, 노드링크는 기존 문항. 각 12시행에 지각·이해·결과 4지선다를 제시한다. 결과는 회상 6 + 대안 예측 6.",
            "timing": "두 UI 및 두 평가 목적 모두 공통 고정 검토시간 후 응답. 판단 RT는 이 고정시간을 포함하며 이후 시간도 별도 기록.",
            "gaze": "시선 장비 직접 연결 없음. 동기화 보조용 화면 전환/AOI 좌표 이벤트만 기록.",
            "limits": "파일럿용 구현. SA 문항은 검증된 척도가 아니며 난이도와 문항 타당도를 확인해야 함."}


def aggregate(session):
    records = [r for r in session["records"] if not r["practice"]]
    behavior = [r for r in records if r["purpose"] == "behavior"]
    invalid = [r for r in behavior if not r["valid"]]
    valid = [r for r in behavior if r["valid"]]
    hits = sum(r["judgment"] == "change" for r in invalid)
    false_alarms = sum(r["judgment"] == "change" for r in valid)
    missing = sum(r["judgment"] is None for r in behavior)
    ratio = lambda a, b: a / b if b else None
    hit, fa = ratio(hits, len(invalid)), ratio(false_alarms, len(valid))
    answers = [a for r in records for a in r.get("answers", [])]
    def accuracy(key, field="level"):
        aa = [a for a in answers if a[field] == key]
        return ratio(sum(a["correct"] for a in aa), len(aa))
    comprehension, outcome = accuracy("comprehension"), accuracy("outcome")
    return {"session_id": session["id"], "participant": session["config"]["participant"],
            "condition": session["config"]["condition"], "mode": session["config"]["mode"],
            "completed_main": len(records), "planned_main": 6 if session["config"]["mode"] == "demo" else 36,
            "sa_primary": (comprehension + outcome) / 2 if comprehension is not None and outcome is not None else None,
            "perception": accuracy("perception"), "comprehension": comprehension, "outcome": outcome,
            "recall": accuracy("recall", "subtype"), "projection": accuracy("projection", "subtype"),
            "invalid_denominator": len(invalid), "valid_denominator": len(valid), "hits": hits,
            "false_alarms": false_alarms, "hit_rate": hit, "false_alarm_rate": fa,
            "missing_judgments": missing,
            "balanced_accuracy": (hit + 1 - fa) / 2 if hit is not None and fa is not None and not missing else None,
            "final_accuracy": ratio(sum(r["final_correct"] for r in behavior), len(behavior)),
            "timeouts": sum(r.get("timeout", False) for r in records),
            "interrupted_trials": sum(r.get("interrupted", False) for r in records),
            "raw_tlx": session.get("survey", {}).get("raw_tlx"),
            "weighted_tlx": session.get("survey", {}).get("weighted_tlx"),
            "survey_version": session.get("survey_version", "raw-tlx-v1"),
            "bank_sha256": session["bank_sha256"], "protocol_version": session.get('version', VERSION),
            "sa_bank_version": session.get('sa_bank_version'), "sa_bank_sha256": session.get('sa_bank_sha256')}
