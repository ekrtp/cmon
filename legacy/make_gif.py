from PIL import Image, ImageDraw, ImageFont
import os

FONT_PATH = "C:/Windows/Fonts/consola.ttf"
FONT_SIZE = 15
BG       = (18, 18, 18)
FG       = (204, 204, 204)
DIM      = (100, 100, 100)
RED      = (255, 85, 85)
YELLOW   = (255, 195, 0)
CYAN     = (85, 215, 255)
GREEN    = (80, 210, 100)
WHITE    = (230, 230, 230)
BOLD_RED = (255, 60, 60)

font      = ImageFont.truetype(FONT_PATH, FONT_SIZE)
font_bold = ImageFont.truetype(FONT_PATH, FONT_SIZE)  # Consolas has no separate bold; simulate

def text_size(text, fnt):
    bbox = fnt.getbbox(text)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]

CHAR_W, CHAR_H = text_size("M", font)
LINE_H = CHAR_H + 5
PAD_X, PAD_Y = 20, 16
COLS, ROWS = 92, 18
IMG_W = PAD_X * 2 + CHAR_W * COLS
IMG_H = PAD_Y * 2 + LINE_H * ROWS

def make_frame(lines):
    img  = Image.new("RGB", (IMG_W, IMG_H), BG)
    draw = ImageDraw.Draw(img)
    for row, segments in enumerate(lines):
        x = PAD_X
        y = PAD_Y + row * LINE_H
        for text, color, bold in segments:
            draw.text((x, y), text, font=font, fill=color)
            x += CHAR_W * len(text)
    return img

DIV = "─" * 90

def header_frame(title, subtitle_color, subtitle):
    return [
        [(" ", FG, False)],
        [(title, WHITE, True), ("   ", FG, False), (subtitle, subtitle_color, False)],
        [(DIV, DIM, False)],
    ]

def table_header():
    return [
        [("  ", FG, False),
         ("PROJECT          ", WHITE, True),
         ("STATUS        ", WHITE, True),
         ("LAST ACTION    ", WHITE, True),
         ("SESSION ID                             ", WHITE, True),
         ("TIME", WHITE, True)],
        [(DIV, DIM, False)],
    ]

def session_row(project, status, message, session_id, time_str, waiting=False):
    icons = {"working": ">>", "thinking": "..", "waiting": "!!", "done": "OK", "running": "--"}
    col   = {"working": YELLOW, "thinking": CYAN, "waiting": BOLD_RED, "done": GREEN, "running": WHITE}
    icon  = icons.get(status, "·")
    color = col.get(status, DIM)

    proj = (project + " " * 17)[:17]
    stat = (f"{icon} {status}" + " " * 13)[:13]
    msg  = (message + " " * 14)[:14]
    sid  = (session_id + " " * 37)[:37]

    if waiting:
        return [("  ", FG, False),
                (proj + " ", BOLD_RED, True),
                (stat + " ", BOLD_RED, True),
                (msg + " ", BOLD_RED, True),
                (sid + " ", DIM, False),
                (time_str + "  ← you", BOLD_RED, True)]
    else:
        return [("  ", FG, False),
                (proj + " ", FG, False),
                (stat + " ", color, False),
                (msg + " ", DIM, False),
                (sid + " ", DIM, False),
                (time_str, DIM, False)]

def footer(n):
    return [
        [(DIV, DIM, False)],
        [(f"  {n} session(s) · refreshes every 2s · Ctrl+C to exit", DIM, False)],
        [(" ", FG, False)],
    ]

SESSIONS = [
    ("e-commerce",  "3e6a048c-43e1-4ded-87e9-7624b2b28d9f"),
    ("dashboard",   "08dcc352-70cc-41aa-b88d-b4bb31a7d245"),
    ("mobile-app",  "fca54d80-c0fa-4611-b557-00dbb9a3c81d"),
    ("auth-service","23912abc-cafe-dead-beef-000000000001"),
]

def build(rows):
    h = header_frame(*rows["header"])
    t = table_header()
    s = [session_row(*r) for r in rows["sessions"]]
    f = footer(len(rows["sessions"]))
    lines = h + t + s + f
    return make_frame(lines)

states = [
    # 1 — all idle at start
    dict(
        header=(" Claude Monitor ", DIM, "10:30:00 AM"),
        sessions=[
            ("e-commerce",   "running", "idle",       SESSIONS[0][1], "now"),
            ("dashboard",    "running", "idle",       SESSIONS[1][1], "now"),
            ("mobile-app",   "running", "idle",       SESSIONS[2][1], "now"),
            ("auth-service", "running", "idle",       SESSIONS[3][1], "now"),
        ]
    ),
    # 2 — e-commerce starts working
    dict(
        header=(" Claude Monitor ", DIM, "10:30:04 AM"),
        sessions=[
            ("e-commerce",   "working", "Bash",       SESSIONS[0][1], "2s"),
            ("dashboard",    "running", "idle",       SESSIONS[1][1], "6s"),
            ("mobile-app",   "running", "idle",       SESSIONS[2][1], "6s"),
            ("auth-service", "running", "idle",       SESSIONS[3][1], "6s"),
        ]
    ),
    # 3 — e-commerce thinking, dashboard starts
    dict(
        header=(" Claude Monitor ", DIM, "10:30:09 AM"),
        sessions=[
            ("e-commerce",   "thinking","Write",      SESSIONS[0][1], "5s"),
            ("dashboard",    "working", "Read",       SESSIONS[1][1], "1s"),
            ("mobile-app",   "running", "idle",       SESSIONS[2][1], "11s"),
            ("auth-service", "running", "idle",       SESSIONS[3][1], "11s"),
        ]
    ),
    # 4 — mobile-app waiting, e-commerce done
    dict(
        header=(" Claude Monitor  ⚠  1 needs your attention ", BOLD_RED, "10:30:16 AM"),
        sessions=[
            ("mobile-app",   "waiting", "idle_prompt",SESSIONS[2][1], "now",  True),
            ("e-commerce",   "done",    "",            SESSIONS[0][1], "12s"),
            ("dashboard",    "thinking","Bash",        SESSIONS[1][1], "7s"),
            ("auth-service", "running", "idle",        SESSIONS[3][1], "18s"),
        ]
    ),
    # 5 — mobile-app now running again, auth-service waiting
    dict(
        header=(" Claude Monitor  ⚠  1 needs your attention ", BOLD_RED, "10:30:24 AM"),
        sessions=[
            ("auth-service", "waiting", "idle_prompt",SESSIONS[3][1], "now",  True),
            ("mobile-app",   "working", "Edit",        SESSIONS[2][1], "8s"),
            ("e-commerce",   "done",    "",             SESSIONS[0][1], "20s"),
            ("dashboard",    "done",    "",             SESSIONS[1][1], "15s"),
        ]
    ),
    # 6 — all done / idle
    dict(
        header=(" Claude Monitor ", DIM, "10:30:35 AM"),
        sessions=[
            ("e-commerce",   "done",    "",            SESSIONS[0][1], "31s"),
            ("dashboard",    "done",    "",            SESSIONS[1][1], "26s"),
            ("mobile-app",   "done",    "",            SESSIONS[2][1], "11s"),
            ("auth-service", "done",    "",            SESSIONS[3][1], "3s"),
        ]
    ),
]

frames = []
durations = []

for i, state in enumerate(states):
    frame = build(state)
    # Hold each state for a bit; waiting states longer
    hold = 2200 if "⚠" not in state["header"][0] else 3000
    frames.append(frame)
    durations.append(hold)

out = os.path.join(os.path.expanduser("~"), "claude_monitor_demo.gif")
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=False,
)
print(f"Saved: {out}")
