"""只检查评测种子结构，不执行模型或判断文学质量。"""
import json
from collections import Counter
from pathlib import Path

source = Path(__file__).resolve().parents[1] / 'fixtures' / 'dev-seed.jsonl'
ids = set()
counts = Counter()
for number, line in enumerate(source.read_text().splitlines(), 1):
    row = json.loads(line)
    assert row['schema_version'] == 1, (number, '未知版本')
    assert row['id'] not in ids, (number, '重复ID')
    ids.add(row['id'])
    assert row['category'] in {'连续性', '悬念', '修改', '阅读效果', '文风控制'}
    assert row['input']['task'] and row['input']['context']
    assert row['input']['output_language'] == '中文'
    assert 'judge_only' not in row['input']
    assert len(row['judge_only']['checks']) >= 3
    assert row['judge_only']['failure_example']
    counts[row['category']] += 1
assert len(ids) == 15 and all(v == 3 for v in counts.values())
print('结构检查通过：15项原创开发种子，每类3项。未执行模型评测。')
