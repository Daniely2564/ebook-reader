// Lumen Reader renders PDFs with its own pdf.js-based viewer (src/reader/pdf),
// so foliate-js never needs to open them. This stub keeps view.js's dynamic
// import resolvable without bundling a second copy of pdf.js.
export const makePDF = async () => {
    throw new Error('PDF files are handled by the Lumen PDF engine')
}
