"""Render public guide JSON from generate-tester-guide.mjs; no runtime service dependency."""
import json
import sys
from html import escape

from reportlab.graphics.shapes import Drawing, Line, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
)


def main():
    guide = json.load(sys.stdin)
    ink, green, muted = map(colors.HexColor, ("#172126", "#0f6149", "#50616b"))
    styles = {
        "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=27, leading=31, textColor=ink, spaceAfter=18),
        "heading": ParagraphStyle("heading", fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=green, spaceAfter=8),
        "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=14, textColor=ink, spaceAfter=10, alignment=TA_LEFT),
        "small": ParagraphStyle("small", fontName="Helvetica", fontSize=9, leading=12, textColor=muted, spaceAfter=10),
    }

    def text(value, style="body"):
        return Paragraph(escape(value), styles[style])

    def footer(canvas, doc):
        canvas.setTitle("VitaAi local simulation tester guide")
        canvas.setAuthor("VitaAi")
        canvas.setSubject(guide["guideVersion"] + " / public content SHA256 " + guide["contentHash"])
        canvas.setStrokeColor(colors.HexColor("#dce3e9"))
        canvas.line(48, 39, A4[0] - 48, 39)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(muted)
        canvas.drawString(48, 25, "VitaAi / " + guide["guideVersion"] + " / local simulation instructions")
        canvas.drawRightString(A4[0] - 48, 25, str(doc.page))

    diagram = Drawing(490, 280)
    labels = [
        ("Review", "Inspect the saved plan and its risks"),
        ("Evidence", "Keep original sources, dates and Unknowns"),
        ("Outreach", "Prepare exact synthetic content"),
        ("CRM Note", "Prepare only if selected by this plan"),
        ("Approval", "Authenticated review of exact saved bytes"),
        ("Execution", "Separate explicit simulation dispatch + readback"),
        ("Outcome", "Separate observed human report"),
    ]
    for index, (label, detail) in enumerate(labels):
        y = 245 - index * 39
        diagram.add(Rect(0, y, 490, 32, fillColor=colors.HexColor("#edf5f0"), strokeColor=colors.HexColor("#b9cfc3")))
        diagram.add(String(12, y + 11, str(index + 1) + ". " + label, fontName="Helvetica-Bold", fontSize=10, fillColor=green))
        diagram.add(String(115, y + 11, detail, fontName="Helvetica", fontSize=9, fillColor=ink))
        if index < 6:
            diagram.add(Line(36, y, 36, y - 7, strokeColor=green))

    story = [text("VitaAi", "heading"), text("Local simulation\ntester guide", "title"),
             text(guide["guideVersion"], "small"), text(guide["guideIntro"]),
             text("Before testing", "heading"), text(guide["guidePrerequisites"]),
             Spacer(1, 8), text("Seven views, separate authority", "heading"), diagram,
             text("Conceptual workflow diagram, not a screenshot or test result. Opening a view does not advance the mission. A simulation receipt is not external delivery or a business outcome.", "small"),
             PageBreak()]
    for index, step in enumerate(guide["guideSteps"]):
        if index == 5:
            story.append(PageBreak())
        story.append(KeepTogether([
            text(str(index + 1) + ". " + step["title"], "heading"),
            text("Action: " + step["action"]), text("Expected observation: " + step["expected"], "small"), Spacer(1, 8),
        ]))
    story.extend([PageBreak(), text("Record what you observed", "title"),
                  text("Blank feedback template. Complete it only with actual observations. Copying or downloading does not submit anything. Review and redact before sharing."),
                  Preformatted(guide["feedbackTemplate"], ParagraphStyle("feedback", fontName="Helvetica", fontSize=10, leading=23), maxLineLength=85)])
    doc = SimpleDocTemplate(sys.argv[1], pagesize=A4, rightMargin=48, leftMargin=48, topMargin=45, bottomMargin=54, invariant=1)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    main()
