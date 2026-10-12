// Runs from a blocking `<script>` in the head of the side panel and Settings, before the
// stylesheet applies, so the page's first frame is already in the right theme. See theme.js.
import { applyTheme } from './theme.js';

applyTheme();
