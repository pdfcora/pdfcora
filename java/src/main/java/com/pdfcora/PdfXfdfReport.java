package com.pdfcora;

import java.util.List;

/** What {@code importXfdf} applied. Skipped entries are in the order they appear in the XFDF. */
public record PdfXfdfReport(int fieldsSet, int annotationsAdded, List<PdfXfdfSkip> skipped) {}
