#!/usr/bin/env python3
"""Post one GitHub Discussion per new paint so the operator gets a phone
push via GitHub Mobile.

Runs as its own workflow step, separate from the scanner, and uses only
the standard library, so the `discussions: write` token never enters the
step that runs third-party pip code. Reads new_paints.json (written by
main.py) and posts each entry. The post is authored by github-actions[bot]
and @-mentions you, so you actually get notified (GitHub never notifies you
about your own actions) and the "Direct mentions" push fires reliably.

No-op unless PAINT_ALERT_GH_USER is set, so a fork of the bot stays silent.
Best-effort: every failure is logged and swallowed so a notify problem
never fails the workflow.

Env:
  PAINT_ALERT_GH_USER   GitHub username to @mention (required; off if unset)
  PAINT_ALERT_REPO      owner/repo to post in (default $GITHUB_REPOSITORY)
  PAINT_ALERT_CATEGORY  discussion category name (default "General")
  GITHUB_TOKEN          token with discussions:write
  NOTIFY_DRY_RUN        '1' to print instead of posting
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NEW_PAINTS_FILE = os.path.join(HERE, "new_paints.json")
GRAPHQL_URL = "https://api.github.com/graphql"


def _gql(query: str, variables: dict, token: str) -> dict:
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
        headers={
            "Authorization": f"bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "tagwall-paint-notifier",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        out = json.load(resp)
    if out.get("errors"):
        raise RuntimeError(f"GraphQL errors: {out['errors']}")
    return out["data"]


def _resolve_ids(repo: str, category: str, token: str) -> tuple[str, str]:
    owner, name = repo.split("/", 1)
    data = _gql(
        "query($o:String!,$n:String!){repository(owner:$o,name:$n)"
        "{id discussionCategories(first:25){nodes{id name}}}}",
        {"o": owner, "n": name},
        token,
    )
    r = data["repository"]
    for node in r["discussionCategories"]["nodes"]:
        if node["name"].lower() == category.lower():
            return r["id"], node["id"]
    have = [n["name"] for n in r["discussionCategories"]["nodes"]]
    raise RuntimeError(f"discussion category {category!r} not found in {repo} (have: {have})")


def _render(user: str, p: dict) -> tuple[str, str]:
    title = f"🎨 {p['chain']}: {p['w']}×{p['h']} ({p['pixels']:,}px) at ({p['x']},{p['y']})"
    base = (os.environ.get("TAGWALL_BASE_URL") or "https://tagwall.io").rstrip("/")
    lines = [f"@{user} new paint on **{p['chain']}**", ""]
    # Rendered image of the tag (server-side, /api/tag-image on the canvas
    # site decodes the paint tx's calldata into an upscaled PNG).
    lines.append(f"![tag]({base}/api/tag-image?chain={p['chainId']}&tx={p['tx']})")
    lines.append("")
    lines.append(f"- region: **{p['w']}×{p['h']}** ({p['pixels']:,} px) at ({p['x']},{p['y']})")
    lines.append(f"- price: **{p['price']}**")
    lines.append(f"- painter: `{p['painter']}`")
    link = p.get("link")
    if link:
        # Painter-supplied URL. Shown verbatim (no auto-link markdown) since
        # it's arbitrary content in the operator's private alert feed.
        lines.append(f"- link: `{link}`")
    lines.append(f"- [view pixel]({p['pixelUrl']}) · [tx]({p['txUrl']})")
    return title, "\n".join(lines) + "\n"


def main() -> int:
    user = os.environ.get("PAINT_ALERT_GH_USER")
    if not user:
        print("[notify] PAINT_ALERT_GH_USER unset; skipping")
        return 0

    try:
        with open(NEW_PAINTS_FILE) as f:
            paints = json.load(f).get("paints", [])
    except FileNotFoundError:
        print("[notify] no new_paints.json; nothing to post")
        return 0
    if not paints:
        print("[notify] no new paints this run")
        return 0

    dry = os.environ.get("NOTIFY_DRY_RUN", "").lower() in {"1", "true", "yes"}
    repo = os.environ.get("PAINT_ALERT_REPO") or os.environ.get("GITHUB_REPOSITORY")
    category = os.environ.get("PAINT_ALERT_CATEGORY") or "General"
    token = os.environ.get("GITHUB_TOKEN")

    if not dry and (not token or not repo):
        print("[notify] missing GITHUB_TOKEN or repo; skipping", file=sys.stderr)
        return 0

    repo_id = cat_id = None
    if not dry:
        try:
            repo_id, cat_id = _resolve_ids(repo, category, token)
        except Exception as err:
            # Non-fatal: most likely Discussions not enabled / category
            # renamed / token lacks discussions:write. Don't fail the run.
            print(f"[notify] could not resolve repo+category: {err}", file=sys.stderr)
            return 0

    posted = 0
    for p in paints:
        title, body = _render(user, p)
        if dry:
            print(f"[notify DRY] TITLE: {title}\n{body}")
            posted += 1
            continue
        try:
            _gql(
                "mutation($r:ID!,$c:ID!,$t:String!,$b:String!)"
                "{createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b})"
                "{discussion{url}}}",
                {"r": repo_id, "c": cat_id, "t": title, "b": body},
                token,
            )
            posted += 1
        except Exception as err:
            print(f"[notify] post failed for {p.get('tx')}: {err}", file=sys.stderr)

    print(f"[notify] posted {posted}/{len(paints)} paint alert(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
