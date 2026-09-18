#!/usr/bin/env python3
# JEV_EVAL: skill-routing threshold calibration over past Pi sessions.
# Per session: digest (80KB cap) -> parallel full-body Noul per skill -> scores JSON.
# Labels are agent-assigned from session openings; review before trusting.
import json, os, sys, time, urllib.request, urllib.error, concurrent.futures
sys.path.insert(0, "/tmp")
from jev_probe import session_digest

API = "https://api.typesafe.ai/v1/systemone"
KEY = os.environ["PI_TYPESAFE_JEV"]
CAP = 80_000

LABELS = {  # proj -> expected relevant skills (agent-assigned, human-reviewable)
    "data": ["browser-use"],
    "data-projects-heavy-thinking": ["heavy-think"],
    "data-projects-loqum_io": ["landing-page"],
    "data-projects-piui": ["design-taste-frontend"],
    "data-projects-platform": ["spec"],
    "data-projects-loqum_landing": ["herdr"],
    "data-projects-mcd-japan-data": [],
    "data-personas-omnara": [],
    "root": [],
    "data-content-Research": [],
    "home-alex": [],
    "data-projects-withanna": [],
}

def skills_catalog():
    roots = ["/tmp/jev-skills",
             os.path.expanduser("~/.pi/agent/skills"),
             os.path.expanduser("~/.pi/agent/git/github.com/Growth-Kinetics/gk-pi/skills"),
             os.path.expanduser("~/.pi/agent/git/github.com/Growth-Kinetics/gk-pi/node_modules/pi-heavy-think/skills")]
    out, seen = [], set()
    for root in roots:
        for dirpath, _, files in os.walk(root):
            if "SKILL.md" in files and os.path.basename(dirpath) not in seen:
                seen.add(os.path.basename(dirpath))
                out.append((os.path.basename(dirpath), os.path.join(dirpath, "SKILL.md")))
    return out

def score_skill(state, name, content):
    q = {"should_load": {"type": "noul",
         "instructions": f"Below is the full documentation of a candidate agent skill named '{name}'. Should this skill be loaded into the agent's context to help with the user's work in the conversation state?",
         "criteria": {"true": "The conversation's task directly involves this skill's domain or the user explicitly referenced it",
                      "false": "Unrelated or only tangentially related"}}}
    body = json.dumps({"state": state, "model": "jev-latest", "questions": q}).encode()
    req = urllib.request.Request(API, data=body, method="POST",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read())
            return d["answers"]["should_load"]["noul"], d["usage"]["input_tokens"], None
    except urllib.error.HTTPError as e:
        return None, None, f"HTTP {e.code}"

def main():
    meta = {m["proj"]: m["path"] for m in json.load(open("/tmp/jev_eval_sessions.json"))}
    catalog = skills_catalog()
    results, t_all = [], time.time()
    for proj, relevant in LABELS.items():
        path = meta.get(proj)
        if not path:
            print(f"SKIP {proj}: no session", file=sys.stderr); continue
        digest, _ = session_digest(path, CAP)
        t0 = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(catalog)) as ex:
            scores = dict(zip([n for n, _ in catalog],
                              ex.map(lambda nc: score_skill(digest, nc[0], open(nc[1]).read()), catalog)))
        results.append({"proj": proj, "relevant": relevant,
                        "scores": {n: s for n, (s, _, _) in scores.items()},
                        "errors": {n: e for n, (_, _, e) in scores.items() if e}})
        top = sorted(scores.items(), key=lambda kv: -(kv[1][0] or 0))[:3]
        print(f"{proj}: expect={relevant or 'none'} top3={[(n, round(s,2)) for n,(s,_,_) in top]} ({time.time()-t0:.1f}s)", file=sys.stderr)
    json.dump(results, open("/tmp/jev_eval_results.json", "w"), indent=1)
    print(f"\ntotal wall {time.time()-t_all:.0f}s, sessions={len(results)}", file=sys.stderr)

    # aggregate distributions
    rel, irrel = [], []
    for r in results:
        for n, s in r["scores"].items():
            if s is None: continue
            (rel if n in r["relevant"] else irrel).append(s)
    irrel.sort()
    pct = lambda v, p: v[min(len(v)-1, int(len(v)*p))]
    print(f"\nRELEVANT (n={len(rel)}):   {sorted(round(s,3) for s in rel)}")
    print(f"IRRELEVANT (n={len(irrel)}): min={irrel[0]:.3f} p50={pct(irrel,.5):.3f} p90={pct(irrel,.9):.3f} p99={pct(irrel,.99):.3f} max={irrel[-1]:.3f}")
    if rel and irrel:
        print(f"separation: min(relevant)={min(rel):.3f} vs max(irrelevant)={irrel[-1]:.3f} margin={min(rel)-irrel[-1]:+.3f}")

if __name__ == "__main__":
    main()
