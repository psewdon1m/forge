# Windows document editor matrix

**Open file** hands a read-only copy to the default Windows app. **Edit copy** asks which editor to use and prepares a writable copy in the Forge profile. Save in the editor and choose **Import changes** in Forge to publish a new project version. **Replace file** can import a separately edited file. A project ZIP retains the original and each committed version with their file hashes.

The development qualification used Windows 11 build 22631 and LibreOffice 26.8.3 x64. The portable test copy was extracted from a Windows installer verified against The Document Foundation's SHA-256 metadata and its Authenticode signature. The test left system file associations intact.

| Format | Reference document | Verified editor | Observed result |
| --- | --- | --- | --- |
| DOCX | Two pages with heading styles, a three-row table, a page break and a bookmark | LibreOffice Writer 26.8.3 | Edited one table cell. Styles, table shape, break and bookmark stayed intact. At 85 DPI the pixel changes were confined to the edited number. Page 2 matched pixel for pixel. |
| PDF | Two-page tagged PDF with a text layer and a document outline | LibreOffice Draw 26.8.3 | Added visible text and retained both page sizes and the original text. Rendering changed around existing text. The outline changed from three entries to two. Use an editor that preserves any outline, tagging, form or signature on which your document depends. |

The automated real-editor run selected fixtures and captured the exact file sent to the editor via the development test bridge. Writer and Draw opened and saved those editable bytes. The Forge UI imported the results. The run reopened the original and edited versions by hash after ZIP restore. A separate desktop regression covers Replace file, canceled and failed editor choices and conflict behavior.

On the development host, the installed candidate opened a DOCX through the new standard profile's registered WordPad handler. WordPad displayed the expected text and warned about incomplete format support. The handed-off copy was read-only and matched the original SHA-256. In a temporary standard account inside the existing interactive session, the development build identified the chooser failure as Windows error `0x80070005`. Forge removed the failed initial working copy, preserved the project revision, and offered **Replace file**. When reopening an existing working copy fails, Forge retains that copy and offers its folder. Verify the registered handlers and editor launch through **Just once** in the isolated standard-user release profile on supported Windows.

For a release-host check, open both formats with **Open file** and confirm that the registered app opens the expected version. Start **Edit copy** and choose the qualified editor without changing the default association. Make a controlled edit, save and close the editor. Import the result into Forge and compare page shape and document features to the original. Exercise **Replace file** with a separately saved copy. Export a project backup, restore it into an empty directory and open the original and current versions from the restored project.
