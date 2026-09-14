# Hardcover book and series discovery

[Back to ShelfSend](../README.md) · [Device comparison](devices.md)

Hardcover discovery lets you explore a book's series and compare its titles with all indexed books in your selected library. It does not download books or change mounted originals.

## Set up and explore

1. Add and test a Hardcover personal API token with catalog and search access in **Settings → Series & book details (Hardcover)**. The credential stays in durable server storage and is never returned unmasked or persisted in the browser.
2. Open a book's details and choose **Explore on Hardcover**. ShelfSend looks up the book by ISBN, then title and author when needed. Choose the intended book if multiple candidates appear.
3. Use **View on Hardcover** to open the external book page, or **View series** to explore the series. Choose a series if the book belongs to more than one.
4. Review covers, titles, authors, and volume positions. Open a matching local book directly, or use **Load more books** for longer series.

If discovery needs setup, has no result, or cannot reach the provider, the interface explains the state and offers the applicable setup or retry action. Browsing a series does not apply suggested metadata. Review and apply metadata suggestions separately in the metadata editor.

## Understand the library comparison

| Status | Meaning |
| --- | --- |
| **In your library** | The selected library contains a match supported by ISBN equivalence or title/author evidence. |
| **Missing** | No matching indexed book was found in the selected library. |
| **Possible match** | The available evidence is uncertain or ambiguous; inspect the candidate before deciding whether you own the volume. |

The comparison covers the selected library across all catalog pages, using source and effective metadata. It is independent of the current browsing filter. Offline source folders do not erase indexed ownership. If the catalog cannot be compared within its limits, discovery reports an error instead of presenting incomplete results as missing books.

These are library-ownership statuses. Device-presence badges come from the connected reader's current checks; Hardcover matches never authorize device removal or replacement.

## Series roster and limits

ShelfSend uses Hardcover's series roster. It excludes merged, partial, and compilation records and selects the most popular remaining book per reported position before pagination, reducing repeated translated or special-edition volume cards. Fractional positions such as `1.5` remain distinct; entries with no position share one representative.

This selection represents the provider's main/popular work per volume. It does not guarantee the original language or earliest edition, and the displayed title can be an English title supplied by Hardcover. Series results therefore depend on the provider's metadata quality and coverage.

Provider discovery and matching have automated and rendered-interface coverage. **Live Hardcover account/token acceptance remains separate**; fixture checks do not establish that a particular account can complete a live lookup.
