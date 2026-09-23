# Procurement Discovery Architecture

BidWatch treats procurement discovery as an ingestion and classification problem rather than a keyword-search problem.

## Source hierarchy

1. MANePS: primary government e-procurement source.
2. PPDA: official procurement notice publication.
3. Malawi Government: central government tender publication repository.
4. Careers Malawi: broad secondary discovery source.
5. Institutional procurement pages: ministries, authorities, universities, councils and public companies.
6. World Bank: donor-funded procurement opportunities.
7. UNGM: UN agency procurement opportunities.
8. Secondary aggregators: discovery and cross-check only.

The current production connector set is MANePS, PPDA, Malawi Government and Careers Malawi. Institutional, World Bank and UNGM connectors should be added as separate source adapters rather than folded into the generic scraper.

## Connector rules

Every connector should:

- fetch the source without requiring a supplier login unless the source explicitly requires one;
- preserve the original source URL;
- extract raw source facts without inventing missing fields;
- record fetch, parse, relevance and failure counts;
- distinguish a source failure from a legitimate zero-result scan;
- tolerate pagination and changing page layouts;
- retain document URLs when exposed;
- expose source health to administrators.

AI extraction is not used for source discovery. Deterministic HTML/API extraction is preferred. AI can be introduced later as a bounded fallback for difficult document content, with the original document retained as provenance.

## Normalized opportunity model

Core fields:

- title
- organisation
- reference
- published date
- deadline
- description
- notice type
- procurement method
- source
- source URL
- document URLs
- external identifier
- content hash
- first seen
- last seen

Classification fields:

- relevance score
- relevance level
- fit level
- capability categories
- matched terms
- matched sections
- classification reason
- classifier version

## Classification model

BidWatch intentionally recognises technology opportunities that do not contain the word ICT.

Examples include:

- real-time stock management systems
- biometric access control
- CCTV surveillance
- smart gate systems
- vehicle tracking
- UPS and ICT infrastructure
- software licences
- backup systems
- digital registration systems
- electronic records
- networking and telecommunications
- data and analytics systems

Construction and other non-technology procurements may contain generic technology language such as electronic submission. Those weak signals should not create a technology opportunity by themselves.

## Deduplication

Deduplication priority:

1. procurement reference within the same source;
2. canonical source URL;
3. external identifier;
4. content hash.

Repeated references across different sources remain separate provenance records, with the UI showing that the opportunity was also discovered elsewhere.

## Opportunity lifecycle

A discovery can be:

- New: discovered but not yet imported.
- Imported: converted into an active BidWatch bid.
- Dismissed: intentionally excluded from the discovery workspace.

Historical source observations should not overwrite bid history.

## Filtering

The discovery workspace supports:

- free-text search;
- source;
- organisation;
- capability;
- fit;
- deadline window;
- workflow state;
- relevance/deadline sorting.

The default list includes current and undated records. Expired records remain available through the explicit overdue filter.

## Future source work

### Institutional sources

Create a registry of monitored institutions with:

- institution name;
- procurement URL;
- source type;
- crawl frequency;
- parser type;
- active flag;
- last successful scan;
- last error.

Do not scrape every Malawi website indiscriminately. Start with institutions that repeatedly publish technology procurement.

### World Bank

Add a dedicated connector that filters the World Bank opportunity dataset for Malawi and preserves project and procurement identifiers. Separate current, upcoming and potential opportunities because the World Bank explicitly distinguishes those states.

### UNGM

Add a dedicated connector using the UNGM public procurement opportunity search with Malawi as beneficiary country. Retain UN organization, reference, notice type, publication date, deadline and UNSPSC classifications.

### MANePS and OCDS

Keep the MANePS adapter isolated because its public interfaces are still evolving. PPDA is preparing an MANePS Open Contracting Data Portal, so BidWatch should retain identifiers compatible with OCDS concepts rather than designing a proprietary procurement identity model.

## Operational requirement

A scan returning zero relevant opportunities is only valid when the source was successfully fetched and parsed. A failed fetch, parser failure or blocked endpoint must remain visible as a source error.

This distinction is mandatory for procurement intelligence because an empty screen caused by a broken connector is materially different from an empty screen caused by there being no relevant opportunities.
