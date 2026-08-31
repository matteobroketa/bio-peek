# Security and privacy

bio-peek is a static client-side application. It does not contain application code that uploads selected genomic files to a server.

When deployed on GitHub Pages, the HTML/JavaScript/CSS assets themselves are downloaded from GitHub Pages, but selected local files are accessed through browser `File` objects and read locally.

The application currently makes no analytics or telemetry requests. If analytics, error reporting, remote URL inspection or other network features are added later, they should be documented prominently because genomic data can be sensitive.

For maximum privacy, users may clone the repository and serve it on a trusted local machine.
