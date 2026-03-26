import prisma from "../../config/prisma.js";

export const listPartners = async ({ activeOnly = true } = {}) => {
  const where = activeOnly ? { is_active: true } : {};

  return prisma.partner.findMany({
    where,
    orderBy: { display_order: "asc" },
  });
};

export const getPartner = async (id) => {
  const partner = await prisma.partner.findUnique({ where: { id } });

  if (!partner) {
    const err = new Error("Partner not found");
    err.status = 404;
    throw err;
  }

  return partner;
};

export const createPartner = async (data) => {
  const { name, logo_url, website_url, description, display_order } = data;

  if (!name) {
    const err = new Error("name is required");
    err.status = 400;
    throw err;
  }

  return prisma.partner.create({
    data: {
      name,
      logo_url,
      website_url,
      description,
      is_active: true,
      display_order: display_order ?? 0,
    },
  });
};

export const updatePartner = async (id, data) => {
  const partner = await prisma.partner.findUnique({ where: { id } });

  if (!partner) {
    const err = new Error("Partner not found");
    err.status = 404;
    throw err;
  }

  const { name, logo_url, website_url, description, is_active, display_order } = data;

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (logo_url !== undefined) updateData.logo_url = logo_url;
  if (website_url !== undefined) updateData.website_url = website_url;
  if (description !== undefined) updateData.description = description;
  if (is_active !== undefined) updateData.is_active = is_active;
  if (display_order !== undefined) updateData.display_order = display_order;

  return prisma.partner.update({ where: { id }, data: updateData });
};

export const deletePartner = async (id) => {
  const partner = await prisma.partner.findUnique({ where: { id } });

  if (!partner) {
    const err = new Error("Partner not found");
    err.status = 404;
    throw err;
  }

  await prisma.partner.delete({ where: { id } });
};
