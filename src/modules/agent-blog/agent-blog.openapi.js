/** OpenAPI 3.1 description of the AI blog API, in the shape ChatGPT custom GPT Actions import. */
export const buildOpenApiSpec = (serverUrl) => {
  const post = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      title: { type: "string" },
      excerpt: { type: ["string", "null"] },
      content: { type: "string", description: "HTML body" },
      category: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" } },
      featured_image_url: { type: ["string", "null"] },
      status: { type: "string", enum: ["published", "draft"] },
      slug: { type: "string" },
      url: { type: "string", description: "Public link to the post on ijsds.org" },
      published_at: { type: ["string", "null"], format: "date-time" },
      created_at: { type: "string", format: "date-time" },
    },
  };
  const input = (required) => ({
    type: "object",
    ...(required ? { required: ["title", "content"] } : {}),
    properties: {
      title: { type: "string", maxLength: 200 },
      content: {
        type: "string",
        maxLength: 100000,
        description: "The article body as HTML. Allowed: h2, h3, h4, p, br, hr, strong, em, u, s, sub, sup, ul, ol, li, blockquote, a (href), img (https src, alt), figure, figcaption, code, pre, table. Anything else is removed. Do not repeat the title as a heading.",
      },
      excerpt: { type: "string", maxLength: 500, description: "One or two plain-text sentences shown in the blog list." },
      category: { type: "string", maxLength: 60 },
      tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 } },
      featured_image_url: { type: "string", description: "Optional https URL of a cover image." },
      status: {
        type: "string",
        enum: ["published", "draft"],
        description: required ? "Defaults to published (goes live immediately). Use draft to save without publishing." : "published puts the post live; draft takes it off the site.",
      },
    },
  });
  const error = { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
  const json = (schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
  const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }];

  return {
    openapi: "3.1.0",
    info: {
      title: "IJSDS Blog (AI writer)",
      version: "1.0.0",
      description: "Create and manage blog posts on the IJSDS website (International Journal of Social Work and Development Studies). This API can only touch posts it created.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { AgentKey: { type: "apiKey", in: "header", name: "x-agent-key" } },
      schemas: { Post: post, NewPost: input(true), PostUpdate: input(false) },
    },
    security: [{ AgentKey: [] }],
    paths: {
      "/api/agent/blog/posts": {
        get: {
          operationId: "listBlogPosts",
          summary: "List blog posts this AI has created, newest first",
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
          responses: {
            200: json({ type: "object", properties: { posts: { type: "array", items: { $ref: "#/components/schemas/Post" } } } }),
            401: error, 429: error,
          },
        },
        post: {
          operationId: "createBlogPost",
          summary: "Create a blog post (published immediately unless status is draft)",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewPost" } } } },
          responses: { 201: json({ $ref: "#/components/schemas/Post" }, "Created"), 400: error, 401: error, 429: error },
        },
      },
      "/api/agent/blog/posts/{id}": {
        get: {
          operationId: "getBlogPost",
          summary: "Get one blog post this AI created, with its full content",
          parameters: idParam,
          responses: { 200: json({ $ref: "#/components/schemas/Post" }), 401: error, 404: error },
        },
        patch: {
          operationId: "updateBlogPost",
          summary: "Edit, publish or unpublish a blog post this AI created. Send only the fields to change.",
          parameters: idParam,
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PostUpdate" } } } },
          responses: { 200: json({ $ref: "#/components/schemas/Post" }), 400: error, 401: error, 404: error, 429: error },
        },
      },
    },
  };
};
