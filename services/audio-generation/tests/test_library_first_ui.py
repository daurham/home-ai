"""Fast regression checks for the library-first Music Studio interface.

These checks do not touch the live audio server, download models, or generate WAVs.
Runtime behavior remains covered by test_studio.py.
"""

from pathlib import Path
import unittest


WEB = Path(__file__).resolve().parents[1] / "audio_studio" / "studio_web"


class LibraryFirstUIContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = (WEB / "index.html").read_text(encoding="utf-8")
        cls.script = (WEB / "studio.js").read_text(encoding="utf-8")
        cls.styles = (WEB / "studio.css").read_text(encoding="utf-8")

    def test_library_is_primary_and_queue_is_not_a_tab(self):
        self.assertIn('id="library-heading"', self.page)
        self.assertIn('id="tracks"', self.page)
        self.assertIn('id="search"', self.page)
        self.assertIn('id="sort-tracks"', self.page)
        self.assertIn('id="filter-genre"', self.page)
        self.assertIn('id="filter-favorite"', self.page)
        self.assertNotIn('data-tab="queue"', self.page)
        self.assertIn('id="active-jobs"', self.page)
        self.assertIn('id="history"', self.page)

    def test_generator_is_collapsible_and_uncluttered(self):
        self.assertIn('id="composer-shell"', self.page)
        self.assertIn('id="toggle-compose"', self.page)
        self.assertIn('id="compose"', self.page)
        self.assertIn('id="advanced-settings"', self.page)
        self.assertNotIn('id="moods"', self.page)
        self.assertIn('id="bpm"', self.page)
        self.assertIn('id="key"', self.page)
        self.assertIn('id="time"', self.page)
        self.assertIn('id="seed"', self.page)
        self.assertIn("instrumental: true", self.script)
        self.assertIn('mood: []', self.script)

    def test_sticky_player_and_track_details(self):
        for control in (
            "now-playing", "now-play", "now-prev", "now-next", "now-title",
            "now-seek", "now-volume", "now-download",
            "drawer-layer", "details", "close-details",
        ):
            self.assertIn(f'id="{control}"', self.page)
        self.assertIn("position: fixed", self.styles)
        self.assertIn("function selectTrack", self.script)
        self.assertIn("function openDetails", self.script)
        self.assertIn("function closeDetails", self.script)

    def test_no_external_ui_dependencies_or_inline_script(self):
        self.assertIn("Home AI Music Studio", self.page)
        self.assertIn('src="/assets/studio.js"', self.page)
        self.assertNotIn("https://", self.page)
        self.assertNotIn("http://", self.page)
        self.assertNotIn("<script>", self.page.lower())


if __name__ == "__main__":
    unittest.main()
