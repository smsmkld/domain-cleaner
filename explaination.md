# Google Apps Script - Domain Duplicate Checker

I need you to build a Google Apps Script that checks a new list of domains against multiple Google Sheets stored inside a specific Google Drive folder.

## Goal

The main goal is to prevent duplicate outreach.

I have multiple Google Sheets inside one Google Drive folder. These sheets contain domains that I have already scraped and contacted.

When I get a new list of domains, I want the script to check every new domain against all existing domains in every Google Sheet inside the specified Drive folder.

For each new domain, the script should tell me whether the domain already exists and, if it does, which spreadsheet it was found in. (The script will be in a spreadsheet called domain cleaner!)

## Existing Google Drive Structure

I have one Google Drive folder containing multiple Google Sheets.

Example:

Drive Folder:

* Leads January
* Leads February
* Apollo SaaS
* Apollo Agencies
* Old Leads
* etc.

The spreadsheets can have different layouts.

Some sheets may have a column called:

`domain`

Other sheets may have:

`domains`

A spreadsheet can also contain MULTIPLE columns with the exact same header.

Example:

| Company | domain  | Name | domain  | Email                               |
| ------- | ------- | ---- | ------- | ----------------------------------- |
| ABC     | abc.com | John | abc.com | [john@abc.com](mailto:john@abc.com) |

The script must check ALL columns whose header is exactly `domain` or `domains`.

Do NOT assume there is only one domain column per spreadsheet. A spreadsheet/sheet can have multiple columns named `domain` or `domains`.

## New Domains

The new domains will be placed in a Google Sheet that contains a column named:

`domain`

The script should read all domains from this column and check them against the existing Google Sheets in the Drive folder.

## Domain Matching

Domain matching should be normalized before comparing.

For example, these should all be treated as the same domain:

`https://example.com`

`http://example.com`

`https://www.example.com`

`www.example.com`

`example.com/`

`example.com`

The normalized value should ideally become:

`example.com`

Also remove:

* `http://`
* `https://`
* `www.`
* trailing `/`
* whitespace
* query parameters
* URL fragments

Convert everything to lowercase.

## Results

For every new domain, create a result showing:

| New Domain  | Status    | Found In      |
| ----------- | --------- | ------------- |
| example.com | DUPLICATE | Leads January |
| test.com    | NEW       | Not found     |
| abc.com     | DUPLICATE | Apollo SaaS   |

If a domain exists in multiple spreadsheets, list ALL spreadsheets where it was found.

Example:

`example.com`

Status:

`DUPLICATE`

Found in:

`Leads January, Leads March, Apollo SaaS`

## Important

The script must search EVERY Google Sheet inside the specified Drive folder.

It should:

1. Open the Drive folder using its Folder ID.
2. Get all files inside the folder.
3. Ignore files that are not Google Sheets.
4. Open each Google Sheet.
5. Check every tab/sheet inside the spreadsheet.
6. Read the first row as headers.
7. Find EVERY column whose header is `domain` OR `domains`.
8. Read all values from every matching column.
9. Normalize every domain.
10. Store the domains in memory for fast lookup.
11. Check the new domains against that lookup.
12. Return the duplicate status and source spreadsheet names.

## Performance

Do NOT repeatedly open and scan every spreadsheet for every individual new domain.

Instead:

1. Scan the Drive folder once.
2. Build a Set/Map containing all existing normalized domains.
3. Store the spreadsheet names associated with each domain.
4. Then check the new domains against that Set/Map.

This is important because there may be thousands or hundreds of thousands of existing domains.

Use efficient Apps Script methods such as batch `getValues()` instead of reading cells one at a time.

## Output

Write the results back to the new-domain spreadsheet.

Create columns such as:

`domain`

`status`

`found_in`

Example:

| domain      | status    | found_in               |
| ----------- | --------- | ---------------------- |
| example.com | DUPLICATE | Leads January          |
| test.com    | NEW       |                        |
| abc.com     | DUPLICATE | Apollo SaaS, Old Leads |

Do not modify the original lead spreadsheets.

## Configuration

At the top of the script, create an easy configuration section where I can enter:

* Google Drive Folder ID
* New Domains Spreadsheet ID
* New Domains Sheet Name
* Domain Column Name

Example:

const CONFIG = {
FOLDER_ID: "PASTE_FOLDER_ID_HERE",
NEW_DOMAINS_SPREADSHEET_ID: "PASTE_SPREADSHEET_ID_HERE",
NEW_DOMAINS_SHEET_NAME: "Sheet1",
DOMAIN_HEADERS: ["domain", "domains"]
};

## Duplicate Safety

The purpose of this system is to make sure I never accidentally scrape/contact the same domain twice.

Therefore, matching must be case-insensitive and URL-normalized.

The script should also detect duplicates within the NEW domain list itself.

For example, if the new list contains:

`example.com`

`www.example.com`

`https://example.com`

they should all be identified as the same normalized domain.

The output should clearly show that they are duplicates.

## Error Handling

If a spreadsheet cannot be opened, do not stop the entire script.

Log the error and continue checking the remaining spreadsheets.

At the end, show a summary such as:

* Total new domains checked: 5,000
* New domains: 3,800
* Duplicate domains: 1,200
* Google Sheets scanned: 47
* Errors: 2

## Logging

Use Logger.log() for useful progress information.

For example:

`Scanning spreadsheet: Leads January`

`Found 12,430 domains`

`Scanning spreadsheet: Apollo SaaS`

`Found 8,921 domains`

At the end:

`Finished. 47 spreadsheets scanned.`

## Important Edge Cases

Handle:

* Empty domain cells
* Blank rows
* Duplicate domain columns
* Multiple tabs inside one spreadsheet
* Multiple Google Sheets inside the Drive folder
* Uppercase domains
* URLs instead of domains
* `www.` prefixes
* Trailing slashes
* Query strings
* URL fragments
* Duplicate domains within the same spreadsheet
* Duplicate domains across different spreadsheets
* Duplicate domains within the new input list

Do not treat an empty cell as a domain.

## Final Requirement

Give me the complete Google Apps Script code.

It should be ready to paste into Google Apps Script with only the configuration values needing to be changed.

Also explain exactly:

1. Where I paste the code.
2. What IDs I need to enter.
3. How I run the script.
4. What permissions Google will ask for.
5. How the output will look.
6. How to set up an automatic trigger if I want the check to run automatically.

Keep the code clean and efficient. Do not use external APIs or paid services.
