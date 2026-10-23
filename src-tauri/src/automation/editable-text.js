// Serialize editor line boundaries, ignoring the final BR that browsers use
// as a caret placeholder in an empty or newline-terminated block. innerText
// adds extra newlines for those placeholders; textContent drops all boundaries.
(root) => {
  const read = (parent) => {
    let result = "", seen = false, previousBlock = false;
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.nodeValue) continue;
        if (previousBlock) result += "\n";
        result += child.nodeValue;
        seen = true;
        previousBlock = false;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const display = getComputedStyle(child).display;
        if (display === "none" || ["SCRIPT", "STYLE"].includes(child.tagName)) continue;
        if (child.tagName === "BR") {
          if (child !== parent.lastChild) result += "\n";
          continue;
        }
        const block = ["block", "list-item", "table", "table-row", "flex", "grid", "flow-root"].includes(display);
        if (seen && (block || previousBlock)) result += "\n";
        result += read(child);
        seen = true;
        previousBlock = block;
      }
    }
    return result;
  };
  // Chrome inserts NBSPs to keep typed leading/trailing/repeated spaces visible.
  return read(root).replace(/\u00a0/g, " ");
}
