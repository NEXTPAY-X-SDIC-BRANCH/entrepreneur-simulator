"""lab:modes — 이지 모드(sim/easy.py)의 추천 가게가 화면(web/src/mock/model.ts recommend, guStat, openingCost)과 같은지.

model.ts를 TypeScript 컴파일러(web/node_modules/typescript)로 JS로 바꿔 node에서 같은 자료(web/public/mock)로 돌리고,
파이썬 이식의 값과 하나씩 비교한다. 화면 쪽 규칙이 바뀌면(예: lab:cost의 engineCovers) 이 테스트가 깨져서 이지와 하드가
다른 가게를 추천하는 일을 막는다. node나 typescript가 없으면 건너뛴다.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from sim import easy as E

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
TS = WEB / "node_modules" / "typescript" / "lib" / "typescript.js"
CASES = [["마포구", 12000], ["강남구", 20000], ["종로구", 3000], ["노원구", 8000], ["송파구", 5000], ["중구", 15000], ["관악구", 6000]]
DONGS = [["마포구", "서교동"], ["강남구", "역삼1동"], ["관악구", "신림동"]]

HARNESS = r"""
import ts from %(ts)s;
import fs from "node:fs";
import path from "node:path";
const SRC = %(src)s, OUT = %(out)s, MOCK = %(mock)s;
for (const rel of ["mock/model.ts", "lab/industry/industries.ts"]) {
  let code = ts.transpileModule(fs.readFileSync(path.join(SRC, rel), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  code = code.replace(/from "(\.[^"]+)"/g, (m, p) => `from "${p}.js"`);
  const dst = path.join(OUT, rel.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, code);
}
const m = await import(path.join(OUT, "mock/model.js"));
const get = (f) => JSON.parse(fs.readFileSync(path.join(MOCK, f), "utf8"));
m.setGuData(get("gu_stats.json")); m.setRentData(get("rent_gu.json")); m.setDongData(get("dong_stats.json"));
m.setKrei(get("gogi_krei.json")); m.setEcos(get("ecos_rates.json"));
const [cases, dongs] = JSON.parse(process.argv[2]);
const out = {};
for (const [gu, cap] of cases) {
  const r = m.recommend({ industry: "bbq", gu, reasons: [], capital: cap, age: "30대" });
  const g = m.guStat(gu);
  out[gu + cap] = { p: r.store.pyeong, t: m.storeStats(r.store).tables, staff: r.staff, safe: r.safe, rent: g.rent,
    sh: g.salesHansik, sales: g.sales, open: m.openingCost(r.store, gu).total };
}
for (const [gu, d] of dongs) {
  m.setAreaInput({ gu, name: d });
  const g = m.guStat(gu);
  out[gu + d] = { rent: g.rent, sh: g.salesHansik, q: g.qidx, type: g.areaType };
  m.setAreaInput(null);
}
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def web(tmp_path_factory):
    node = shutil.which("node")
    if not node or not TS.exists():
        pytest.skip("node 또는 web/node_modules/typescript 없음")
    d = tmp_path_factory.mktemp("parity")
    script = d / "harness.mjs"
    q = json.dumps
    script.write_text(HARNESS % {"ts": q(str(TS)), "src": q(str(WEB / "src")), "out": q(str(d / "out")), "mock": q(str(WEB / "public" / "mock"))})
    r = subprocess.run([node, str(script), json.dumps([CASES, DONGS])], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    return json.loads(r.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("gu,cap", CASES)
def test_recommend_matches_web(web, gu, cap):
    st = E.gu_stat("bbq", gu)
    r = E.recommend(st, cap)
    py = {"p": r["store"]["pyeong"], "t": r["store"]["tables"], "staff": r["staff"], "safe": r["safe"], "rent": st["rent"],
          "sh": st["sales_hansik"], "sales": st["sales"], "open": sum(x["amount"] for x in E.opening_cost(r["store"], st["rent"]))}
    w = web[gu + str(cap)]
    for k, v in py.items():
        assert w[k] == pytest.approx(v, abs=1e-6) if isinstance(v, float) else w[k] == v, (k, v, w[k])


@pytest.mark.parametrize("gu,dong", DONGS)
def test_dong_stat_matches_web(web, gu, dong):
    st = E.gu_stat("bbq", gu, dong)
    assert web[gu + dong] == {"rent": st["rent"], "sh": st["sales_hansik"], "q": st["qidx"], "type": st["area_type"]}


def test_easy_store_is_the_recommended_store(web):
    """이지 모드 첫 판의 가게 = 하드 모드 '추천 배치'와 같은 가게."""
    a = E.easy_inputs("bbq", "마포구", 12000)
    w = web["마포구12000"]
    assert (a["store"]["pyeong"], a["store"]["tables"], a["staff"]) == (w["p"], w["t"], w["staff"])
