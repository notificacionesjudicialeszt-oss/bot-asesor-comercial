---
name: generate-docx
description: Generate professional Word (.docx) documents with rich formatting, tables, images, headers, footers, and custom styles.
---

# Generate Word Documents (.docx)

This skill allows you to generate professional Microsoft Word documents programmatically using `python-docx`.

## Prerequisites

- Python 3.x installed
- `python-docx` library installed (`pip install python-docx`)

## How to Use

### Option 1: Run the helper script directly

Use the helper script at `.agents/skills/generate-docx/scripts/generate_docx.py` by passing a JSON specification:

```powershell
python .agents/skills/generate-docx/scripts/generate_docx.py --spec "<JSON_SPEC>" --output "output.docx"
```

### Option 2: Create a custom Python script

For complex documents, create a temporary Python script in `/tmp/` and run it. Use the examples in `.agents/skills/generate-docx/examples/` as reference.

## JSON Specification Format

The helper script accepts a JSON spec with the following structure:

```json
{
  "title": "Document Title",
  "subtitle": "Optional Subtitle",
  "author": "Author Name",
  "styles": {
    "font_name": "Calibri",
    "font_size": 11,
    "heading_font": "Calibri",
    "primary_color": "1F4E79"
  },
  "header_text": "Header text for all pages",
  "footer_text": "Footer text for all pages",
  "content": [
    {
      "type": "heading",
      "level": 1,
      "text": "Section Title"
    },
    {
      "type": "paragraph",
      "text": "Regular paragraph text. Supports **bold** and *italic* inline markers.",
      "alignment": "left"
    },
    {
      "type": "bullet_list",
      "items": ["Item 1", "Item 2", "Item 3"]
    },
    {
      "type": "numbered_list",
      "items": ["First", "Second", "Third"]
    },
    {
      "type": "table",
      "headers": ["Column 1", "Column 2", "Column 3"],
      "rows": [
        ["Cell 1", "Cell 2", "Cell 3"],
        ["Cell 4", "Cell 5", "Cell 6"]
      ],
      "style": "Medium Shading 1 Accent 1"
    },
    {
      "type": "image",
      "path": "path/to/image.png",
      "width_inches": 4,
      "caption": "Figure 1: Description"
    },
    {
      "type": "page_break"
    },
    {
      "type": "horizontal_rule"
    }
  ]
}
```

## Supported Content Types

| Type | Description | Key Properties |
|------|-------------|----------------|
| `heading` | Section headings (H1-H4) | `level`, `text` |
| `paragraph` | Body text with optional formatting | `text`, `alignment` (left/center/right/justify), `bold`, `italic` |
| `bullet_list` | Unordered list | `items` (array of strings) |
| `numbered_list` | Ordered list | `items` (array of strings) |
| `table` | Data table with headers | `headers`, `rows`, `style` |
| `image` | Embedded image | `path`, `width_inches`, `caption` |
| `page_break` | Insert a page break | (no extra properties) |
| `horizontal_rule` | Horizontal line separator | (no extra properties) |

## Table Styles Available

Common Word table styles you can use:
- `Table Grid`
- `Light List Accent 1`
- `Medium Shading 1 Accent 1`
- `Medium Grid 3 Accent 1`
- `Dark List Accent 1`

## Inline Formatting

Within paragraph text, use:
- `**bold text**` for **bold**
- `*italic text*` for *italic*

## Tips

1. **For complex documents**: Write a custom Python script instead of using JSON spec. This gives you full control over `python-docx` API.
2. **Images**: Use absolute paths for images. Generate images first using the `generate_image` tool if needed.
3. **Output path**: Always save output files to the user's workspace, not `/tmp/`.
4. **Templates**: If the user has a Word template (.dotx), you can use it as a base with `Document('template.dotx')`.

## Common Patterns

### Legal Document
```python
from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
style = doc.styles['Normal']
style.font.name = 'Times New Roman'
style.font.size = Pt(12)
style.paragraph_format.line_spacing = 1.5
```

### Report with Logo
```python
doc = Document()
doc.add_picture('logo.png', width=Inches(2))
doc.add_heading('Quarterly Report', level=0)
doc.add_paragraph('Generated on: ' + datetime.now().strftime('%B %d, %Y'))
```

### Invoice/Table-heavy Document
```python
table = doc.add_table(rows=1, cols=4, style='Medium Shading 1 Accent 1')
hdr = table.rows[0].cells
hdr[0].text = 'Item'
hdr[1].text = 'Qty'
hdr[2].text = 'Price'
hdr[3].text = 'Total'
```
