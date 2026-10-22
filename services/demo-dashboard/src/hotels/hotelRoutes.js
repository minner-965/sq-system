import express from 'express';
import { canEditHotel, hotelPriceLines, listHotels, updateHotelPrices } from './hotelService.js';

export function createHotelRouter({ pool, auth }) {
  const router = express.Router();

  router.get('/', auth.authenticate, async (req, res, next) => {
    try {
      const hotels = await listHotels(pool);
      res.json({ can_edit: canEditHotel(req.managementUser), items: hotels.map(hotel => ({ ...hotel, public_price_lines: hotelPriceLines(hotel) })) });
    } catch (error) { next(error); }
  });

  router.put('/:id/prices', auth.authenticate, auth.requireWrite, async (req, res, next) => {
    try {
      const hotel = await updateHotelPrices(pool, { hotelId: req.params.id, body: req.body, user: req.managementUser });
      res.json({ ...hotel, public_price_lines: hotelPriceLines(hotel) });
    } catch (error) { next(error); }
  });

  return router;
}
