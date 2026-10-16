#!/usr/bin/env python3
"""Render the README device mockups from assets/raw/ screenshots.

Requires Playwright with Chromium. Run: python3 scripts/render_mockups.py
Each HTML file in assets/mockups/ holds one element per image (id = file name).
"""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ASSETS = Path(__file__).resolve().parent.parent / "assets"
PAGES = {
    "mockups.html": ["hero", "tablet-afternoon", "tablet-highlight", "tablet-editor"],
    "phone-sensors.html": ["phone-sensors"],
}


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1600, "height": 1400}, device_scale_factor=1.25)
        for html, images in PAGES.items():
            await page.goto((ASSETS / "mockups" / html).as_uri())
            await page.wait_for_load_state("networkidle")
            for name in images:
                await page.locator(f"#{name}").screenshot(path=str(ASSETS / f"{name}.png"))
                print(f"assets/{name}.png")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
