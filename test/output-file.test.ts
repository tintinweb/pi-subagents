import { describe, expect, it } from "vitest";
import { encodeCwd } from "../src/output-file.js";

describe("encodeCwd", () => {
  it("encodes a POSIX absolute path by stripping the leading slash and replacing separators", () => {
    expect(encodeCwd("/home/user/project")).toBe("home-user-project");
  });

  it("handles a POSIX root path", () => {
    expect(encodeCwd("/")).toBe("");
  });

  it("encodes a Windows drive-letter path by stripping the drive prefix", () => {
    expect(encodeCwd("C:\\Users\\foo\\project")).toBe("Users-foo-project");
  });

  it("handles lowercase Windows drives", () => {
    expect(encodeCwd("c:\\foo")).toBe("foo");
  });

  it("handles a Windows path written with forward slashes", () => {
    expect(encodeCwd("C:/Users/foo/project")).toBe("Users-foo-project");
  });

  it("preserves server and share for UNC paths", () => {
    expect(encodeCwd("\\\\server\\share\\project")).toBe("server-share-project");
  });

  it("handles mixed separators", () => {
    expect(encodeCwd("/home\\user/project")).toBe("home-user-project");
  });

  it("collapses runs of leading dashes after separator replacement", () => {
    expect(encodeCwd("///foo")).toBe("foo");
  });

  it("returns an empty string for an empty cwd", () => {
    expect(encodeCwd("")).toBe("");
  });

  it("leaves a relative-looking path with no leading separator alone", () => {
    expect(encodeCwd("foo/bar")).toBe("foo-bar");
  });
});
