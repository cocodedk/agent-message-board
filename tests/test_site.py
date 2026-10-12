"""Check deployable metadata and discovery against the files they describe."""

import json
import re
import struct
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree

import pytest

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "website"
ORIGIN = "https://agentboard.cocode.dk/"
LANGUAGES = {"en": ORIGIN, "fa": ORIGIN + "fa/", "x-default": ORIGIN}


class Page(HTMLParser):
    def __init__(self, path: Path) -> None:
        super().__init__()
        self.tags: list[tuple[str, dict[str, str]]] = []
        self.title = ""
        self.structured = ""
        self.current = ""
        self.in_head = False
        self.feed(path.read_text())

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: value or "" for key, value in attrs}
        self.tags.append((tag, attributes))
        if tag == "head":
            self.in_head = True
        if self.in_head and (tag == "title" or attributes.get("type") == "application/ld+json"):
            self.current = tag

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self.in_head = False
        if tag == self.current:
            self.current = ""

    def handle_data(self, data: str) -> None:
        if self.current == "title":
            self.title += data
        elif self.current == "script":
            self.structured += data

    def meta(self, key: str) -> str:
        matches = [attrs["content"] for tag, attrs in self.tags
                   if tag == "meta" and key in (attrs.get("name"), attrs.get("property"))]
        assert len(matches) == 1, f"Expected one {key}"
        return matches[0]


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
    return struct.unpack(">II", data[16:24])


@pytest.mark.parametrize("language", ["en", "fa"])
def test_public_metadata_matches_localized_page_and_share_asset(language: str) -> None:
    page = Page(SITE / ("index.html" if language == "en" else "fa/index.html"))
    html = next(attrs for tag, attrs in page.tags if tag == "html")
    assert html["lang"] == language
    assert html.get("dir") == "rtl" if language == "fa" else html.get("dir", "ltr") == "ltr"
    assert 20 <= len(page.title.strip()) <= 85
    description = page.meta("description")
    assert 80 <= len(description) <= 180
    assert "noindex" not in page.meta("robots")
    canonical = [
        attrs["href"]
        for tag, attrs in page.tags
        if tag == "link" and attrs.get("rel") == "canonical"
    ]
    assert canonical == [LANGUAGES[language]]
    alternates = {
        attrs["hreflang"]: attrs["href"]
        for tag, attrs in page.tags
        if tag == "link" and "hreflang" in attrs
    }
    assert alternates == LANGUAGES
    assert page.meta("og:url") == canonical[0]
    assert page.meta("og:type") == "website"
    assert page.meta("og:locale") == {"en": "en_US", "fa": "fa_IR"}[language]
    for prefix in ("og", "twitter"):
        assert page.meta(f"{prefix}:title") == page.title
        assert page.meta(f"{prefix}:description") == description
        assert page.meta(f"{prefix}:image:alt").strip()
    image = page.meta("og:image")
    assert image == page.meta("twitter:image") and image.startswith(ORIGIN)
    assert png_size(SITE / urlsplit(image).path.lstrip("/")) == (1200, 630)
    assert (int(page.meta("og:image:width")), int(page.meta("og:image:height"))) == (1200, 630)
    assert page.meta("twitter:card") == "summary_large_image"


@pytest.mark.parametrize("language", ["en", "fa"])
def test_structured_data_describes_documentation_and_actual_source(language: str) -> None:
    page = Page(SITE / ("index.html" if language == "en" else "fa/index.html"))
    document = json.loads(page.structured)
    assert document["@context"] == "https://schema.org"
    graph = {item["@type"]: item for item in document["@graph"]}
    site, app, source = (
        graph[key] for key in ("WebSite", "SoftwareApplication", "SoftwareSourceCode")
    )
    assert site["url"] == ORIGIN and set(site["inLanguage"]) == {"en", "fa"}
    assert site["about"]["@id"] == app["@id"] == source["targetProduct"]["@id"]
    assert app["name"] == "Agent Board" and app["applicationCategory"] == "DeveloperApplication"
    assert app["downloadUrl"] == source["codeRepository"]
    assert source["codeRepository"] == "https://github.com/cocodedk/agent-message-board"
    assert source["programmingLanguage"] == "Python"
    assert app["offers"]["price"] == "0"
    assert not any(key in app for key in ("aggregateRating", "review"))


def test_favicon_family_has_valid_sizes_and_resolves_on_all_pages() -> None:
    svg = ElementTree.parse(SITE / "favicon.svg").getroot()
    assert svg.tag == "{http://www.w3.org/2000/svg}svg" and "viewBox" in svg.attrib
    assert svg.findall(".//{http://www.w3.org/2000/svg}path")
    assert png_size(SITE / "favicon.png") in ((48, 48), (96, 96))
    assert png_size(SITE / "apple-touch-icon.png") == (180, 180)
    data = (SITE / "favicon.ico").read_bytes()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    assert (reserved, kind, count) == (0, 1, 3)
    sizes = set()
    for index in range(count):
        width, height, _, _, _, depth, length, offset = struct.unpack_from(
            "<BBBBHHII", data, 6 + index * 16
        )
        sizes.add((width or 256, height or 256))
        assert depth == 32 and length > 0 and offset >= 6 + 16 * count
        assert offset + length <= len(data)
    assert sizes == {(16, 16), (32, 32), (48, 48)}
    for path, url in (
        (SITE / "index.html", ORIGIN),
        (SITE / "fa/index.html", ORIGIN + "fa/"),
        (ROOT / "viewer/index.html", "http://localhost/board/"),
    ):
        icons = [
            attrs["href"]
            for tag, attrs in Page(path).tags
            if tag == "link" and attrs.get("rel") in ("icon", "apple-touch-icon")
        ]
        assert {Path(urlsplit(urljoin(url, href)).path).name for href in icons} == {
            "favicon.ico",
            "favicon.svg",
            "favicon.png",
            "apple-touch-icon.png",
        }
        assert all(
            (SITE / Path(urlsplit(urljoin(url, href)).path).name).is_file() for href in icons
        )


@pytest.mark.parametrize("directory", ["website", "viewer"])
def test_discovery_format_links_and_registered_tool_names(directory: str) -> None:
    text = (ROOT / directory / "llms.txt").read_text()
    assert text.startswith("# ") and re.search(r"^> \S", text, re.M)
    sections = re.split(r"^## .+$", text, flags=re.M)[1:]
    assert sections and all(
        re.search(r"^- \[[^]]+\]\([^)]+\)", section, re.M) for section in sections
    )
    page = Page(ROOT / directory / "index.html")
    assert any(tag == "link" and attrs.get("rel") == "describedby" for tag, attrs in page.tags)
    module = (ROOT / directory / "webmcp.js").read_text()
    names = set(re.findall(r"(?:name:\s*|tool\()['\"]([a-z_]+)['\"]", module))
    assert "describe" in names and "registerTool" in module
    assert all(re.search(rf"\b{re.escape(name)}\b", text) for name in names)
    for target in re.findall(r"^- \[[^]]+\]\(([^)]+)\)", text, re.M):
        parsed = urlsplit(
            urljoin(ORIGIN if directory == "website" else "http://localhost/", target)
        )
        assert parsed.scheme in ("http", "https") and parsed.netloc
        if directory == "website" and parsed.netloc == urlsplit(ORIGIN).netloc:
            path = SITE / parsed.path.lstrip("/")
            path = path / "index.html" if parsed.path.endswith("/") else path
            assert path.is_file(), target
            if parsed.fragment:
                assert any(attrs.get("id") == parsed.fragment for _, attrs in Page(path).tags)


def test_public_discovery_alias_and_search_crawling_are_deployable() -> None:
    assert (ROOT / "llms.txt").read_bytes() == (SITE / "llms.txt").read_bytes()
    alias = SITE / "llm.txt"
    workflow = (ROOT / ".github/workflows/pages.yml").read_text()
    if alias.exists():
        assert alias.read_bytes() == (SITE / "llms.txt").read_bytes()
    else:
        assert re.search(r"cp\s+website/llms\.txt\s+website/llm\.txt", workflow)
    sitemap = ElementTree.parse(SITE / "sitemap.xml")
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9", "h": "http://www.w3.org/1999/xhtml"}
    assert {item.text for item in sitemap.findall("s:url/s:loc", ns)} == {ORIGIN, ORIGIN + "fa/"}
    for entry in sitemap.findall("s:url", ns):
        assert {
            link.attrib["hreflang"]: link.attrib["href"] for link in entry.findall("h:link", ns)
        } == LANGUAGES
    robots = (SITE / "robots.txt").read_text()
    assert "Disallow: /" not in robots and f"Sitemap: {ORIGIN}sitemap.xml" in robots
