package com.pdfcora.xfdf

import org.junit.Assert.assertEquals
import org.junit.Test

class XfdfXmlTest {
    @Test fun formatNumberTrimsToFourDecimals() {
        assertEquals("1.2346", XfdfXml.format(1.23456))
        assertEquals("2.5", XfdfXml.format(2.5))
        assertEquals("0", XfdfXml.format(-0.0))
        assertEquals("0", XfdfXml.format(-0.00001))
        assertEquals("72", XfdfXml.format(72.0))
        assertEquals("100", XfdfXml.format(100.0))
    }

    @Test fun escapesAttributesAndText() {
        assertEquals("Zoë &amp; &quot;Co&quot; &lt;ok&gt; &apos;", XfdfXml.escapeAttribute("Zoë & \"Co\" <ok> '"))
        assertEquals("Zoë &amp; \"Co\" &lt;ok&gt;", XfdfXml.escapeText("Zoë & \"Co\" <ok>"))
    }
}
