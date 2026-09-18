#!/usr/bin/env python3
# JEV_PROBE: escalating context-size probes against TypeSafe System One (jev-latest)
# INPUTS: session jsonl path, target payload size in bytes, skill file (optional)
# OUTPUTS: status, latency, usage tokens, answers — printed, no secrets echoed
import json, os, sys, time, urllib.request, urllib.error

API = "https://api.typesafe.ai/v1/systemone"
KEY = os.environ["PI_TYPESAFE_JEV"]

def session_text(path, cap_bytes):
    """Extract role-tagged text from a Pi session JSONL, capped at cap_bytes."""
    out, total = [], 0
    with open(path) as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") != "message":
                continue
            m = e.get("message", {})
            role = m.get("role", "?")
            for part in m.get("content", []):
                t = part.get("text") or part.get("thinking") or ""
                if not t:
                    continue
                chunk = f"[{role}] {t}\n"
                if total + len(chunk) > cap_bytes:
                    return "".join(out)
                out.append(chunk)
                total += len(chunk)
    return "".join(out)

def session_digest(path, cap_bytes):
    """Digest: user turns + assistant text/thinking only. Tool calls/results dropped, no summarization."""
    out, total = [], 0
    st = {"user": 0, "asst_text": 0, "asst_think": 0, "tool_msgs": 0, "tool_bytes": 0, "keep_bytes": 0}
    with open(path) as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") != "message":
                continue
            m = e.get("message", {})
            role = m.get("role", "?")
            if role not in ("user", "assistant"):
                st["tool_msgs"] += 1
                st["tool_bytes"] += sum(len(p.get("text", "")) for p in m.get("content", []) if isinstance(p, dict))
                continue
            for part in m.get("content", []):
                pt = part.get("type")
                if pt == "text":
                    t, k = part.get("text", ""), "user" if role == "user" else "asst_text"
                elif pt == "thinking":
                    t, k = part.get("thinking", ""), "asst_think"
                else:
                    st["tool_bytes"] += len(json.dumps(part.get("arguments", {}))) if pt == "toolCall" else 0
                    continue
                if not t:
                    continue
                chunk = f"[{role}] {t}\n"
                st[k] += 1
                st["keep_bytes"] += len(chunk)
                if total + len(chunk) > cap_bytes:
                    return "".join(out), st
                out.append(chunk)
                total += len(chunk)
    return "".join(out), st

def probe(state, questions, label):
    body = json.dumps({"state": state, "model": "jev-latest", "questions": questions}).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            dt = time.time() - t0
            data = json.loads(r.read())
            print(f"\n=== {label}: HTTP {r.status} in {dt:.2f}s, payload={len(body)/1024:.0f}KB")
            print(f"usage: {json.dumps(data.get('usage'))}")
            for qid, a in data.get("answers", {}).items():
                slim = {k: v for k, v in a.items() if k in ("type", "noul", "choice", "score", "confidence")}
                print(f"  {qid}: {json.dumps(slim)}")
            return True
    except urllib.error.HTTPError as e:
        dt = time.time() - t0
        print(f"\n=== {label}: HTTP {e.code} in {dt:.2f}s, payload={len(body)/1024:.0f}KB")
        print(f"  error body: {e.read().decode()[:500]}")
        return False

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "smoke":
        probe("The user asks how Pi loads skills and how they are injected into the session.",
              {"typesafe_skill_relevant": {"type": "noul", "instructions": "Would a skill about the TypeSafe/Jev API be relevant to the user's current task?"},
               "neon_skill_relevant": {"type": "noul", "instructions": "Would a skill about the Neon serverless Postgres database be relevant to the user's current task?"}},
              "SMOKE")
    elif mode == "session":
        path, cap = sys.argv[2], int(sys.argv[3])
        txt = session_text(path, cap)
        print(f"extracted {len(txt)/1024:.0f}KB text from {path}", file=sys.stderr)
        probe(txt,
              {"typesafe_skill_relevant": {"type": "noul", "instructions": "Would a skill documenting the TypeSafe System One API (typed judgment questions over state) be relevant to what the user is working on here?"},
               "neon_skill_relevant": {"type": "noul", "instructions": "Would a skill about the Neon serverless Postgres platform be relevant to what the user is working on here?"},
               "tldraw_skill_relevant": {"type": "noul", "instructions": "Would a skill for drawing on a shared tldraw whiteboard be relevant to what the user is working on here?"}},
              f"SESSION cap={cap}")
    elif mode == "digest":
        path, cap = sys.argv[2], int(sys.argv[3])
        txt, st = session_digest(path, cap)
        print(f"digest {len(txt)/1024:.0f}KB kept={st['keep_bytes']/1024:.0f}KB tool_bytes_dropped={st['tool_bytes']/1024/1024:.1f}MB "
              f"user_msgs={st['user']} asst_text={st['asst_text']} asst_think={st['asst_think']} tool_msgs_skipped={st['tool_msgs']}", file=sys.stderr)
        probe(txt,
              {"typesafe_skill_relevant": {"type": "noul", "instructions": "Would a skill documenting the TypeSafe System One API (typed judgment questions over state) be relevant to what the user is working on here?"},
               "neon_skill_relevant": {"type": "noul", "instructions": "Would a skill about the Neon serverless Postgres platform be relevant to what the user is working on here?"},
               "tldraw_skill_relevant": {"type": "noul", "instructions": "Would a skill for drawing on a shared tldraw whiteboard be relevant to what the user is working on here?"}},
              f"DIGEST cap={cap}")
    elif mode == "route_all":
        import concurrent.futures
        path, cap = sys.argv[2], int(sys.argv[3])
        txt, st = session_digest(path, cap)
        print(f"digest {len(txt)/1024:.0f}KB user_msgs={st['user']} asst={st['asst_text']}+{st['asst_think']}", file=sys.stderr)
        roots = ["/tmp/jev-skills",os.path.expanduser("~/.pi/agent/skills"),
                 os.path.expanduser("~/.pi/agent/git/github.com/Growth-Kinetics/gk-pi/skills"),
                 os.path.expanduser("~/.pi/agent/git/github.com/Growth-Kinetics/gk-pi/node_modules/pi-heavy-think/skills")]
        skills, seen = [], set()
        for root in roots:
            for dirpath, _, files in os.walk(root):
                if "SKILL.md" in files:
                    name = os.path.basename(dirpath)
                    if name not in seen:
                        seen.add(name)
                        skills.append((name, os.path.join(dirpath, "SKILL.md")))
        print(f"skills discovered: {len(skills)}", file=sys.stderr)

        def one(name_path):
            name, p = name_path
            content = open(p).read()
            q = {"should_load": {"type": "noul",
                  "instructions": f"Below is the full documentation of a candidate agent skill named '{name}'. Should this skill be loaded into the agent's context to help with the user's current work in the conversation state?\n\n--- SKILL DOCUMENTATION ---\n{content}",
                  "criteria": {"true": "The conversation's task directly involves this skill's domain or the user explicitly referenced it",
                               "false": "Unrelated or only tangentially related"}}}
            body = json.dumps({"state": txt, "model": "jev-latest", "questions": q}).encode()
            req = urllib.request.Request(API, data=body, method="POST", headers={
                "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    d = json.loads(r.read())
                    return name, time.time() - t0, d["answers"]["should_load"]["noul"], d["usage"]["input_tokens"], None
            except urllib.error.HTTPError as e:
                return name, time.time() - t0, None, None, f"HTTP {e.code}"

        wall0 = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(skills)) as ex:
            results = list(ex.map(one, skills))
        wall = time.time() - wall0
        tot_tokens = sum(r[3] or 0 for r in results)
        print(f"\n=== ROUTE_ALL: {len(results)} skills in parallel, wall={wall:.2f}s, total_input={tot_tokens:,} tok, cost=${tot_tokens*0.042/1e6:.4f}")
        for name, dt, score, tok, err in sorted(results, key=lambda r: -(r[2] or 0)):
            print(f"  {score if score is not None else err}  {name}  ({dt:.1f}s, {tok:,} tok)" if tok else f"  {err}  {name}")
    elif mode == "with_skill":
        path, cap, skill = sys.argv[2], int(sys.argv[3]), sys.argv[4]
        txt = session_text(path, cap)
        sk = open(skill).read()
        state = {"conversation": txt, "candidate_skill": {"name": os.path.basename(os.path.dirname(skill)), "content": sk}}
        print(f"extracted {len(txt)/1024:.0f}KB convo + {len(sk)/1024:.0f}KB skill", file=sys.stderr)
        probe(state,
              {"should_load_skill": {"type": "noul", "instructions": "Should the candidate skill be loaded to help with the user's current work in this conversation?",
                                      "criteria": {"true": "The conversation's task directly involves this skill's domain", "false": "Unrelated or only tangentially related"}}},
              f"WITH_SKILL cap={cap}")
